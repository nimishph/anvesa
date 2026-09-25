import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditMapping, refineMapping } from './mappings.ts';

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) {
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  }
});

const CSHARP_CODE = `namespace App;

public class Greeter
{
    private string name;

    public Greeter(string name)
    {
        this.name = name;
    }

    public string SayHello()
    {
        return "Hello " + name;
    }
}
`;

function makeCsharpProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'anvesa-mappings-test-'));
  roots.push(root);
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'Greeter.cs'), CSHARP_CODE);
  return root;
}

const host = {
  npmFrom: join(import.meta.dir, '../../cli/src/cli.ts'),
};

describe('mapping audit and refine', () => {
  test('audit discovers unmapped node types and candidate rules', async () => {
    const root = makeCsharpProject();
    const audit = await auditMapping(root, { language: 'csharp' }, host);

    expect(audit.language).toBe('csharp');
    expect(audit.samplesCount).toBe(1);
    expect(audit.totalNodes).toBeGreaterThan(10);
    expect(audit.unmappedCount).toBeGreaterThan(0);

    const classCandidate = audit.candidates.find((c) => c.type === 'class_declaration');
    expect(classCandidate).toBeDefined();
    expect(classCandidate?.deducedTag).toBe('class');
    expect(classCandidate?.role).toBe('declaration');

    const methodCandidate = audit.candidates.find((c) => c.type === 'method_declaration');
    expect(methodCandidate).toBeDefined();
    expect(methodCandidate?.deducedTag).toBe('method');
  });

  test('refine automatically learns rules, installs golden record and locks mapping', async () => {
    const root = makeCsharpProject();

    // 1. Dry run produces rules without saving
    const dry = await refineMapping(root, { language: 'csharp', dryRun: true }, host);
    expect(dry.addedRules.length).toBeGreaterThan(0);
    expect(dry.stored).toBeUndefined();
    expect(existsSync(join(root, '.anvesa', 'mappings', 'csharp.json'))).toBe(false);

    // 2. Real refine saves and locks
    const result = await refineMapping(root, { language: 'csharp' }, host);
    expect(result.addedRules.length).toBeGreaterThan(0);
    expect(result.stored).toBeDefined();
    expect(result.stored?.tier).toBe('project');
    expect(existsSync(join(root, '.anvesa', 'mappings', 'csharp.json'))).toBe(true);
    expect(existsSync(join(root, '.anvesa', 'mappings.lock.json'))).toBe(true);

    // 3. Second audit now sees class_declaration and method_declaration as mapped
    const postAudit = await auditMapping(root, { language: 'csharp' }, host);
    const unmappedTypes = new Set(postAudit.unmappedTypes);
    expect(unmappedTypes.has('class_declaration')).toBe(false);
    expect(unmappedTypes.has('method_declaration')).toBe(false);
  });
});
