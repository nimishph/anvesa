import { defineConfig } from 'vitepress';

const repo = 'https://github.com/nimishph/anvesa';
const base = '/anvesa/';

export default defineConfig({
  base,
  title: 'anveṣa',
  description:
    'Find code by meaning and by structure. Hybrid neural dense embeddings + AST Wildcard Query Language (WQL).',
  lang: 'en-US',
  cleanUrls: true,
  lastUpdated: true,
  ignoreDeadLinks: false,
  editLink: false,
  srcExclude: ['README.md'],

  head: [
    ['link', { rel: 'icon', href: `${base}favicon.svg`, type: 'image/svg+xml' }],
    ['meta', { name: 'theme-color', content: '#10b981' }],
  ],

  themeConfig: {
    logo: '/logo.svg',
    siteTitle: 'anveṣa',

    socialLinks: [{ icon: 'github', link: repo }],

    nav: [
      { text: 'Guide', link: '/guide/getting-started', activeMatch: '/guide/' },
      { text: 'WQL', link: '/guide/wql', activeMatch: '/guide/wql' },
      { text: 'Reference', link: '/cli', activeMatch: '/cli' },
      { text: 'Overview', link: '/overview' },
    ],

    sidebar: [
      {
        text: 'Introduction',
        items: [
          { text: 'What Anvesa Is', link: '/overview' },
          { text: 'Getting Started', link: '/guide/getting-started' },
        ],
      },
      {
        text: 'Core Retrieval Engines',
        items: [
          { text: 'Wildcard Query Language (WQL)', link: '/guide/wql' },
          { text: 'Reciprocal Rank Fusion (RRF)', link: '/guide/fusion' },
          { text: 'Code Graph & Blast Radius', link: '/guide/code-graph' },
        ],
      },
      {
        text: 'AI Agent Usability',
        items: [
          { text: 'MCP Server Daemon', link: '/guide/agent-mcp' },
          { text: 'Token-Frugal Primer', link: '/guide/primer' },
          { text: 'Agent Skill Reference', link: '/agent-skill' },
        ],
      },
      {
        text: 'Configuration & Reference',
        items: [
          { text: 'CLI Command Reference', link: '/cli' },
          { text: 'Configuration & $schema', link: '/guide/config' },
        ],
      },
    ],

    outline: { level: [2, 3] },
    docFooter: { prev: 'Previous', next: 'Next' },
    lastUpdated: { text: 'Last updated' },

    search: { provider: 'local' },

    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright © Nimish Phalnikar',
    },
  },
});
