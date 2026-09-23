/**
 * The platforms a program is built for, each on its own machine because the program embeds native
 * code and is smoke-tested by running it. The ONNX runtime ships no macOS x64 build, so there is
 * none here either.
 */
export interface Platform {
  readonly os: 'linux' | 'darwin' | 'win32';
  readonly cpu: 'x64' | 'arm64';
  /** The GitHub Actions runner that builds and tests it. */
  readonly runner: string;
}

export const PLATFORMS: readonly Platform[] = [
  { os: 'linux', cpu: 'x64', runner: 'ubuntu-latest' },
  { os: 'linux', cpu: 'arm64', runner: 'ubuntu-24.04-arm' },
  { os: 'darwin', cpu: 'arm64', runner: 'macos-latest' },
  { os: 'win32', cpu: 'x64', runner: 'windows-latest' },
];

export const SCOPE = '@cntxt-labs';
export const MAIN_PACKAGE = `${SCOPE}/anvesa`;

/** `@cntxt-labs/anvesa-linux-x64`: the package that holds the program for one platform. */
export const platformPackage = (platform: Pick<Platform, 'os' | 'cpu'>): string =>
  `${MAIN_PACKAGE}-${platform.os}-${platform.cpu}`;
