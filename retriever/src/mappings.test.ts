import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { builtinMappings, type LanguageMapping } from '@cntxt-labs/anvesa-structural';
import { auditMapping, mappingStoreFor, refineMapping } from './mappings.ts';

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

/**
 * The bundled C# mapping less its methods, kept in the project: a mapping with a gap that the
 * samples show, which is what audit and refine are for.
 */
async function withoutMethods(root: string): Promise<void> {
  const found = builtinMappings().find((entry) => entry.languages.includes('csharp'))?.mapping;
  expect(found).toBeDefined();
  const bundled = found as LanguageMapping;
  const { method_declaration: _method, ...nodeTypeMap } = bundled.nodeTypeMap;
  const { method_declaration: _name, ...nameExtractors } = bundled.nameExtractors;
  await mappingStoreFor(root, host).install(
    { ...bundled, nodeTypeMap, nameExtractors },
    { tier: 'project', languages: ['csharp'], force: true },
  );
}

describe('mapping audit and refine', () => {
  test('audit sees what the bundled mapping covers, and finds what a mapping leaves out', async () => {
    const root = makeCsharpProject();
    const audit = await auditMapping(root, { language: 'csharp' }, host);
    expect(audit.language).toBe('csharp');
    expect(audit.samplesCount).toBe(1);
    expect(audit.totalNodes).toBeGreaterThan(10);
    expect(audit.unmappedTypes).not.toContain('class_declaration');
    expect(audit.unmappedTypes).not.toContain('method_declaration');

    await withoutMethods(root);
    const gap = await auditMapping(root, { language: 'csharp' }, host);
    expect(gap.unmappedCount).toBeGreaterThan(0);
    const methodCandidate = gap.candidates.find((c) => c.type === 'method_declaration');
    expect(methodCandidate).toBeDefined();
    expect(methodCandidate?.deducedTag).toBe('method');
    expect(methodCandidate?.role).toBe('declaration');
  });

  test('refine automatically learns rules, installs golden record and locks mapping', async () => {
    const root = makeCsharpProject();
    await withoutMethods(root);

    // 1. Dry run produces rules without saving
    const before = readFileSync(join(root, '.anvesa', 'mappings', 'csharp.json'), 'utf8');
    const dry = await refineMapping(root, { language: 'csharp', dryRun: true }, host);
    expect(dry.addedRules.length).toBeGreaterThan(0);
    expect(dry.stored).toBeUndefined();
    expect(readFileSync(join(root, '.anvesa', 'mappings', 'csharp.json'), 'utf8')).toBe(before);

    // 2. Real refine saves and locks
    const result = await refineMapping(root, { language: 'csharp' }, host);
    expect(result.addedRules.length).toBeGreaterThan(0);
    expect(result.stored).toBeDefined();
    expect(result.stored?.tier).toBe('project');
    expect(existsSync(join(root, '.anvesa', 'mappings', 'csharp.json'))).toBe(true);
    expect(existsSync(join(root, '.anvesa', 'mappings.lock.json'))).toBe(true);

    // 3. Second audit now sees the methods as mapped again
    const postAudit = await auditMapping(root, { language: 'csharp' }, host);
    const unmappedTypes = new Set(postAudit.unmappedTypes);
    expect(unmappedTypes.has('class_declaration')).toBe(false);
    expect(unmappedTypes.has('method_declaration')).toBe(false);
  });
});
