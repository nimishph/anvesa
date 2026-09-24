import { describe, expect, test } from 'bun:test';
import { extractVueScript } from './vue.ts';

describe('extractVueScript', () => {
  test('extracts script from standard Vue SFC preserving length and line numbers', () => {
    const sfc = `<template>
  <div @click="handleClick">{{ message }}</div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { formatName } from './utils';

const message = ref('Hello');
function handleClick() {
  formatName(message.value);
}
</script>

<style scoped>
.foo { color: red; }
</style>
`;

    const extracted = extractVueScript(sfc);
    expect(extracted.length).toBe(sfc.length);
    expect(extracted).toContain("import { ref } from 'vue';");
    expect(extracted).toContain("import { formatName } from './utils';");
    expect(extracted).toContain('function handleClick()');
    expect(extracted).not.toContain('<template>');
    expect(extracted).not.toContain('<style scoped>');

    // Check line preservation
    const sfcLines = sfc.split('\n');
    const extLines = extracted.split('\n');
    expect(extLines.length).toBe(sfcLines.length);

    const importLineIndex = sfcLines.findIndex((l) => l.includes("import { ref } from 'vue';"));
    expect(importLineIndex).toBeGreaterThan(0);
    expect(extLines[importLineIndex]).toBe(sfcLines[importLineIndex]);
  });

  test('handles generic script setup with complex generic parameter attributes', () => {
    const sfc = `<template>
  <div>{{ item }}</div>
</template>

<script setup lang="ts" generic="T extends Record<string, unknown>, K extends keyof T">
import { computed } from 'vue';

const props = defineProps<{ item: T; keyName: K }>();
</script>
`;

    const extracted = extractVueScript(sfc);
    expect(extracted.length).toBe(sfc.length);
    expect(extracted).toContain("import { computed } from 'vue';");
    expect(extracted).toContain('defineProps');
    expect(extracted).not.toContain('<script');
  });

  test('extracts multiple script blocks in one SFC (options script + setup script)', () => {
    const sfc = `<script lang="ts">
export interface UserProps {
  id: string;
}
</script>

<script setup lang="ts">
import { ref } from 'vue';
const count = ref(0);
</script>
`;

    const extracted = extractVueScript(sfc);
    expect(extracted.length).toBe(sfc.length);
    expect(extracted).toContain('export interface UserProps');
    expect(extracted).toContain("import { ref } from 'vue';");
  });

  test('blanks out template-only Vue components without throwing', () => {
    const sfc = `<template>
  <div>Static component without script</div>
</template>
`;

    const extracted = extractVueScript(sfc);
    expect(extracted.length).toBe(sfc.length);
    expect(extracted.trim()).toBe('');
  });

  test('leaves raw code without SFC tags untouched', () => {
    const raw = 'const x = 1;\nconst y = 2;';
    expect(extractVueScript(raw)).toBe(raw);
  });
});
