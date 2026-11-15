// Written by cli/scripts/gen-command-index.ts from cli/src/cmd/commands/. Do not edit by hand.

import command_agent_issue from './commands/agent/issue.ts';
import command_agent_mcp from './commands/agent/mcp.ts';
import command_agent_primer from './commands/agent/primer.ts';
import command_agent_skill from './commands/agent/skill.ts';
import command_agent_telemetry from './commands/agent/telemetry.ts';
import command_agent_version from './commands/agent/version.ts';
import command_extend_channel from './commands/extend/channel.ts';
import command_extend_grammar from './commands/extend/grammar.ts';
import command_extend_mapping from './commands/extend/mapping.ts';
import command_extend_model from './commands/extend/model.ts';
import command_extend_pattern from './commands/extend/pattern.ts';
import command_extend_redteam from './commands/extend/redteam.ts';
import command_graph_callees from './commands/graph/callees.ts';
import command_graph_callers from './commands/graph/callers.ts';
import command_graph_dependents from './commands/graph/dependents.ts';
import command_graph_explain from './commands/graph/explain.ts';
import command_graph_map from './commands/graph/map.ts';
import command_graph_neighbors from './commands/graph/neighbors.ts';
import command_graph_routes from './commands/graph/routes.ts';
import command_index_fragments from './commands/index/fragments.ts';
import command_index_index from './commands/index/index.ts';
import command_project_init from './commands/project/init.ts';
import command_project_status from './commands/project/status.ts';
import command_project_ui from './commands/project/ui.ts';
import command_project_where from './commands/project/where.ts';
import command_search_diagnose from './commands/search/diagnose.ts';
import command_search_federation from './commands/search/federation.ts';
import command_search_query from './commands/search/query.ts';
import command_search_retrieve from './commands/search/retrieve.ts';
import command_search_search from './commands/search/search.ts';
import type { Command } from './shared/command.ts';

/** Every command module, as `buildRegistry` takes them. */
export const COMMAND_MODULES: readonly Command[] = [
  command_agent_issue,
  command_agent_mcp,
  command_agent_primer,
  command_agent_skill,
  command_agent_telemetry,
  command_agent_version,
  command_extend_channel,
  command_extend_grammar,
  command_extend_mapping,
  command_extend_model,
  command_extend_pattern,
  command_extend_redteam,
  command_graph_callees,
  command_graph_callers,
  command_graph_dependents,
  command_graph_explain,
  command_graph_map,
  command_graph_neighbors,
  command_graph_routes,
  command_index_fragments,
  command_index_index,
  command_project_init,
  command_project_status,
  command_project_ui,
  command_project_where,
  command_search_diagnose,
  command_search_federation,
  command_search_query,
  command_search_retrieve,
  command_search_search,
];
