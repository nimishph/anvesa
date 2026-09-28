import { ConfigLoader, parseConfig } from './config';
import { log } from './logger';

export function start(name: string) {
  const loader = new ConfigLoader();
  log('starting');
  return loader.load(name);
}

export function quick(name: string) {
  return parseConfig(name, true);
}

export function trace(name: string) {
  log(name);
  console.log(name);
}
