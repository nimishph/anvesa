// Bun's `with { type: 'file' }` import gives the path of the file, and bundles it into a compiled binary.
declare module '*.wasm' {
  const path: string;
  export default path;
}

// `with { type: 'text' }` gives the file's text, bundled into a compiled binary.
declare module '*.md' {
  const text: string;
  export default text;
}
