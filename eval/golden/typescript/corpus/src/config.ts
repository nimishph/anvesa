export interface Settings {
  path: string;
  strict: boolean;
}

export function parseConfig(path: string, strict = false): Settings {
  return { path: normalizePath(path), strict };
}

function normalizePath(path: string): string {
  return path.trim();
}

export class ConfigLoader {
  load(name: string): Settings {
    return parseConfig(name);
  }

  reload(name: string): Settings {
    return this.load(name);
  }
}
