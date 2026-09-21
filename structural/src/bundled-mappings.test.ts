import { afterAll, describe, expect, test } from 'bun:test';
import { builtinMappings } from './mapping.ts';
import { outlineSymbols } from './symbols.ts';
import { disposeEngines, makeEngine } from './test-support.ts';

afterAll(disposeEngines);
const engine = makeEngine();

async function symbols(source: string, path: string): Promise<string[]> {
  const encoded = await engine.encode(source, { path });
  return outlineSymbols(encoded.root).map((s) => `${s.kind} ${s.name}`);
}

const GO = `package server

import "fmt"

type Store struct{ items map[string]int }

type ID = string

func New() *Store { return &Store{} }

func (s *Store) Get(k string) int { return s.items[k] }

func main() {
	s := New()
	fmt.Println(s.Get("a"))
}
`;

const RUST = `use std::fmt;

pub struct Point { x: i32 }
pub enum Kind { A, B }
pub trait Shape { fn area(&self) -> i32; }
pub type Id = u32;
const LIMIT: u32 = 3;
mod inner { pub fn helper() {} }

impl Point {
    pub fn new(x: i32) -> Self { Point { x } }
}

fn main() { let p = Point::new(1); println!("{}", p.x); }
`;

const JAVA = `package p;
import java.util.List;
public class Store {
  public Store() {}
  public int get(String k) { return 1; }
  static class Inner { void run() {} }
}
interface Shape { void draw(); }
enum Colour { RED }
`;

const RUBY = `module Shop
  class Cart
    def add(item)
      items << item
    end

    def self.build
      new
    end
  end
end
`;

describe('mappings learned from real code and shipped with the package', () => {
  test('cover Go, Rust, Java and Ruby, and every one validates', () => {
    const shipped = builtinMappings();
    const languages = shipped.flatMap((entry) => entry.languages);
    for (const language of ['go', 'rust', 'java', 'ruby', 'python', 'php', 'typescript']) {
      expect(languages).toContain(language);
    }
    for (const { mapping } of shipped) {
      expect(mapping.structuralTags.length).toBeGreaterThan(3);
      expect(mapping.extensions.length).toBeGreaterThan(0);
    }
  });

  test('Go files have named symbols', async () => {
    expect(await symbols(GO, 'a.go')).toEqual([
      'type Store',
      'type ID',
      'function New',
      'method Get',
      'function main',
    ]);
  });

  test('Rust files have named symbols', async () => {
    const found = await symbols(RUST, 'a.rs');
    for (const expected of [
      'struct Point',
      'enum Kind',
      'trait Shape',
      'type Id',
      'module inner',
      'function main',
    ]) {
      expect(found).toContain(expected);
    }
    expect(found.filter((name) => name.includes('new') || name.includes('helper'))).toHaveLength(2);
    // A struct literal and an enum variant are not declarations.
    expect(found.filter((name) => name.includes('Point')).length).toBe(1 + 0);
  });

  test('Java files have named symbols', async () => {
    expect(await symbols(JAVA, 'A.java')).toEqual([
      'class Store',
      'method Store.Store',
      'method Store.get',
      'class Store.Inner',
      'method Store.Inner.run',
      'interface Shape',
      'method Shape.draw',
      'enum Colour',
    ]);
  });

  test('Ruby files have named symbols', async () => {
    expect(await symbols(RUBY, 'a.rb')).toEqual([
      'module Shop',
      'class Shop.Cart',
      'method Shop.Cart.add',
      'method Shop.Cart.build',
    ]);
  });
});
