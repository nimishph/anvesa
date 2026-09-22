import { defineTransformer, type InputFile, inputFile } from '@cntxt-labs/code-lens-dense';

/** A channel over records that are not files: notes held somewhere else. */
export default defineTransformer({
  name: 'notes',
  version: '1',
  channel: 'notes',
  categoryId: 'custom.note',
  categoryLabel: 'Note',
  trust: 'untrusted',
  claim: (file: InputFile) => file.path.startsWith('note:'),
  transform: (file: InputFile) => [
    { key: file.path, text: file.content, attrs: { title: file.path } },
  ],
});

export const source = () => ({
  name: 'notes',
  files: () => [
    inputFile('note:deploy', 'deploying the service requires rotating the signing keys first'),
    inputFile('note:oncall', 'the on call engineer restarts the queue worker when lag grows'),
  ],
});
