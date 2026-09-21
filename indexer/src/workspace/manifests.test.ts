import { describe, expect, test } from 'bun:test';
import { ManifestInvalidError } from '../errors.ts';
import {
  bazelDependencies,
  gradleProjectReferences,
  keysOf,
  parseGoMod,
  parseGoWork,
  parseGradleIncludes,
  parseGradleRootName,
  parseJson,
  parsePom,
  parseToml,
  requirementName,
  stringList,
  yamlStringList,
} from './manifests.ts';

describe('JSON and TOML', () => {
  test('valid manifests parse', () => {
    expect(parseJson('{"a":1}', 'package.json')).toEqual({ a: 1 });
    expect(parseToml('[package]\nname = "x"', 'Cargo.toml')).toEqual({ package: { name: 'x' } });
  });

  test('invalid ones fail with a typed error that names the file and keeps the cause', () => {
    for (const run of [
      () => parseJson('{oops', 'a/package.json'),
      () => parseToml('name = ', 'a/Cargo.toml'),
    ]) {
      try {
        run();
        throw new ManifestInvalidError('x', 'x', 'expected a failure');
      } catch (thrown) {
        expect(thrown).toBeInstanceOf(ManifestInvalidError);
        expect((thrown as ManifestInvalidError).message).toMatch(/a\/(package\.json|Cargo\.toml)/);
        expect((thrown as ManifestInvalidError).cause).toBeDefined();
      }
    }
  });

  test('helpers read lists and key sets defensively', () => {
    expect(stringList(['a', 1, 'b', null])).toEqual(['a', 'b']);
    expect(stringList('nope')).toEqual([]);
    expect(keysOf({ a: 1, b: 2 })).toEqual(['a', 'b']);
    expect(keysOf([1, 2])).toEqual([]);
    expect(keysOf(undefined)).toEqual([]);
  });
});

describe('pnpm-workspace.yaml', () => {
  test('reads a block list, with quotes, negation and comments', () => {
    const text = `# workspace
packages:
  - 'packages/*'   # libraries
  - "apps/*"
  - '!apps/legacy'

catalog:
  react: 18
`;
    expect(yamlStringList(text, 'packages')).toEqual(['packages/*', 'apps/*', '!apps/legacy']);
  });

  test('reads a flow list, stops at the next key, tolerates CRLF and a missing key', () => {
    expect(yamlStringList("packages: ['a', b/*]\n", 'packages')).toEqual(['a', 'b/*']);
    expect(yamlStringList('packages:\r\n  - a\r\n  - b\r\nother: 1\r\n', 'packages')).toEqual([
      'a',
      'b',
    ]);
    expect(yamlStringList('name: x\n', 'packages')).toEqual([]);
  });
});

describe('Go', () => {
  test('go.work: single-line and block use, with comments and quotes', () => {
    const text = `go 1.22

use ./tools // helpers
use (
	./svc/a
	"./svc/b"
	// ./svc/disabled
)
`;
    expect(parseGoWork(text)).toEqual(['./tools', './svc/a', './svc/b']);
  });

  test('go.mod: module path, requires (single and block) and local replaces', () => {
    const text = `module github.com/acme/api // the api

go 1.22

require github.com/acme/util v1.2.3
require (
	github.com/acme/core v0.1.0 // indirect
	golang.org/x/text v0.3.0
)

replace github.com/acme/core => ../core
replace golang.org/x/text => golang.org/x/text v0.4.0
`;
    const mod = parseGoMod(text);
    expect(mod.module).toBe('github.com/acme/api');
    expect(mod.requires).toEqual([
      'github.com/acme/util',
      'github.com/acme/core',
      'golang.org/x/text',
    ]);
    expect(mod.replacedWithPaths).toEqual(['../core']);
  });

  test('a go.mod with no module line has none', () => {
    expect(parseGoMod('go 1.22\n').module).toBeUndefined();
  });
});

describe('Maven', () => {
  const pom = `<project>
  <parent><groupId>g</groupId><artifactId>parent-artifact</artifactId></parent>
  <!-- <artifactId>commented-out</artifactId> -->
  <artifactId>app-core</artifactId>
  <modules>
    <module>core</module>
    <module> web </module>
  </modules>
  <dependencyManagement><dependencies><dependency><artifactId>managed</artifactId></dependency></dependencies></dependencyManagement>
  <dependencies>
    <dependency><groupId>g</groupId><artifactId>app-util</artifactId><version>1</version></dependency>
    <dependency><artifactId>junit</artifactId><scope>test</scope></dependency>
  </dependencies>
</project>`;

  test("takes the project's own artifactId, not the parent's or a commented one", () => {
    expect(parsePom(pom).artifactId).toBe('app-core');
  });

  test('lists modules and real dependencies, but not managed ones', () => {
    const parsed = parsePom(pom);
    expect(parsed.modules).toEqual(['core', 'web']);
    expect(parsed.dependencies).toEqual(['app-util', 'junit']);
  });
});

describe('Gradle', () => {
  test('reads include in every spelling, across lines, ignoring comments', () => {
    const text = `rootProject.name = "app"
// include(":ignored")
include(":libs:core", ":libs:util")
include ':plain'
include(
  ":multi:a",
  ":multi:b"
)
/* include(":block-comment") */
`;
    expect(parseGradleIncludes(text)).toEqual([
      'libs/core',
      'libs/util',
      'plain',
      'multi/a',
      'multi/b',
    ]);
    expect(parseGradleRootName(text)).toBe('app');
  });

  test('project references in a build file', () => {
    const text = `dependencies {
  implementation(project(":libs:util"))
  api project(path: ':libs:core')
  implementation("com.x:y:1")
}`;
    expect(gradleProjectReferences(text).sort()).toEqual(['libs/core', 'libs/util']);
  });
});

describe('Bazel and Python', () => {
  test('bazel labels become package names, once each, without targets', () => {
    const text = `deps = [":local", "//services/api:server", "//services/api:client", '//libs/core']`;
    expect(bazelDependencies(text).sort()).toEqual(['//libs/core', '//services/api']);
  });

  test.each([
    ['requests>=2.0', 'requests'],
    ['Django[argon2]==4.2', 'Django'],
    ['pkg_name; python_version > "3.8"', 'pkg_name'],
    ['  spaced', 'spaced'],
    ['zope.interface', 'zope.interface'],
    ['-e ./local', undefined],
  ])('requirementName(%j)', (input, expected) => {
    expect(requirementName(input)).toBe(expected);
  });
});
