import { defineTransformer } from '@cntxt-labs/anvesa-dense';

export default defineTransformer({
  name: 'other',
  version: '1',
  channel: 'other',
  categoryId: 'custom.other',
  categoryLabel: 'Other',
  trust: 'third-party',
  claim: () => false,
  transform: () => [],
});
