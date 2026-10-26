import { describe, expect, test } from 'bun:test';
import { InvalidArgumentError } from '@cntxt-labs/anvesa-core';
import { deviceSetting, gpuProviders } from './backend.ts';

describe('choosing a device', () => {
  test('ANVESA_DEVICE is auto, gpu or cpu, and auto when unset', () => {
    expect(deviceSetting({})).toBe('auto');
    expect(deviceSetting({ ANVESA_DEVICE: ' GPU ' })).toBe('gpu');
    expect(deviceSetting({ ANVESA_DEVICE: 'cpu' })).toBe('cpu');
    expect(() => deviceSetting({ ANVESA_DEVICE: 'cuda' })).toThrow(InvalidArgumentError);
  });

  test('auto tries CUDA on Linux only with an NVIDIA driver, and nothing elsewhere', () => {
    expect(gpuProviders('auto', 'linux', () => true)).toEqual(['cuda']);
    expect(gpuProviders('auto', 'linux', () => false)).toEqual([]);
    expect(gpuProviders('auto', 'win32', () => true)).toEqual([]);
    expect(gpuProviders('auto', 'darwin', () => true)).toEqual([]);
  });

  test('gpu tries what the platform has; cpu tries nothing', () => {
    expect(gpuProviders('gpu', 'linux', () => false)).toEqual(['cuda']);
    expect(gpuProviders('gpu', 'win32')).toEqual(['cuda', 'dml']);
    expect(gpuProviders('gpu', 'darwin')).toEqual(['coreml']);
    expect(gpuProviders('cpu', 'linux', () => true)).toEqual([]);
  });
});
