// Bun's `with { type: 'file' }` import gives the path of the file, and bundles it into a compiled binary.
declare module '*.css' {
  const path: string;
  export default path;
}
declare module '*.html' {
  const path: string;
  export default path;
}
