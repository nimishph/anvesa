// Bun's `with { type: 'file' }` import gives the path of the file, and bundles it into a compiled binary.
declare module '*.wasm' {
  const path: string;
  export default path;
}
