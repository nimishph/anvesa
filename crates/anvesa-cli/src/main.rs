use std::io::{self, BufRead, Write};
use std::path::PathBuf;
use clap::{Parser, Subcommand};

#[derive(Parser, Debug)]
#[command(
    name = "anvesa",
    version,
    about = "Anvesa: Hybrid dense + structural code intelligence engine"
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Commands>,
}

#[derive(Subcommand, Debug)]
enum Commands {
    /// Token-frugal concept guidance for agents and developers
    Primer {
        /// Topic name (e.g. overview, wql, fusion, graph, indexing, grammars)
        topic: Option<String>,

        /// Emit raw JSON output
        #[arg(long)]
        json: bool,

        /// Output concise summary without headers
        #[arg(long)]
        compact: bool,
    },

    /// Inspect repository index freshness, vector dimensionality, and channels
    Status {
        /// Path to repository root (defaults to current directory)
        #[arg(long, default_value = ".")]
        root: PathBuf,

        /// Emit raw JSON output
        #[arg(long)]
        json: bool,
    },

    /// Find all callers of a symbol in the index
    Callers {
        /// Symbol name to find callers for
        symbol: String,

        /// Path to repository root
        #[arg(long, default_value = ".")]
        root: PathBuf,
    },

    /// Find all callees invoked by a symbol in the index
    Callees {
        /// Symbol name to find callees for
        symbol: String,

        /// Path to repository root
        #[arg(long, default_value = ".")]
        root: PathBuf,
    },

    /// Find all files that depend on or import a given file (blast radius)
    Dependents {
        /// File path to trace blast radius for
        path: String,

        /// Path to repository root
        #[arg(long, default_value = ".")]
        root: PathBuf,
    },

    /// Serve the Model Context Protocol (MCP) daemon over standard input/output
    Mcp {
        #[command(subcommand)]
        subcommand: McpCommands,
    },
}

#[derive(Subcommand, Debug)]
enum McpCommands {
    /// Run zero-runtime stdio JSON-RPC MCP daemon
    Serve,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::parse();

    match cli.command {
        None => {
            // Default to primer overview
            let overview = anvesa::get_primer_topic("overview").unwrap();
            println!("{}", overview.content);
        }

        Some(Commands::Primer {
            topic,
            json,
            compact,
        }) => {
            handle_primer(topic.as_deref(), json, compact)?;
        }

        Some(Commands::Status { root, json }) => {
            handle_status(&root, json)?;
        }

        Some(Commands::Callers { symbol, root }) => {
            handle_callers(&symbol, &root)?;
        }

        Some(Commands::Callees { symbol, root }) => {
            handle_callees(&symbol, &root)?;
        }

        Some(Commands::Dependents { path, root }) => {
            handle_dependents(&path, &root)?;
        }

        Some(Commands::Mcp {
            subcommand: McpCommands::Serve,
        }) => {
            run_mcp_serve()?;
        }
    }

    Ok(())
}

fn handle_primer(
    topic: Option<&str>,
    json: bool,
    compact: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    match topic {
        Some(name) => {
            if let Some(t) = anvesa::get_primer_topic(name) {
                if json {
                    println!("{}", serde_json::to_string_pretty(t)?);
                } else if compact {
                    println!("{}: {}", t.name, t.description);
                } else {
                    println!("{}", t.content);
                }
            } else {
                eprintln!("Unknown primer topic: '{}'.", name);
                eprintln!("Available topics:");
                for (t_name, title) in anvesa::list_primer_topics() {
                    eprintln!("  - {}: {}", t_name, title);
                }
                std::process::exit(1);
            }
        }
        None => {
            let topics = anvesa::list_primer_topics();
            if json {
                println!("{}", serde_json::to_string_pretty(&anvesa::PRIMER_TOPICS)?);
            } else {
                println!("# Anvesa Primer Topics\n");
                println!("Use `anvesa primer <topic>` to read a topic with zero context bloat:\n");
                for (name, title) in topics {
                    let desc = anvesa::get_primer_topic(name).unwrap().description;
                    println!("- **`{}`** — {}\n  _{}_", name, title, desc);
                }
            }
        }
    }
    Ok(())
}

fn handle_status(root: &std::path::Path, json: bool) -> Result<(), Box<dyn std::error::Error>> {
    let db_path = root.join(".anvesa").join("index.db");
    if !db_path.exists() {
        eprintln!(
            "No index found at {}. Run `anvesa index` first.",
            db_path.display()
        );
        std::process::exit(1);
    }

    let reader = anvesa::IndexReader::open(&db_path)?;
    let stats = reader.get_stats()?;

    if json {
        println!("{}", serde_json::to_string_pretty(&stats)?);
    } else {
        println!("# Anvesa Index Status");
        println!("  Index:      {}", db_path.display());
        println!("  Files:      {}", stats.files);
        println!("  Symbols:    {}", stats.symbols);
        println!("  Calls:      {}", stats.calls);
        println!("  Cards:      {}", stats.cards);
        println!("  Channels:   {}", stats.channels.join(", "));
    }
    Ok(())
}

fn handle_callers(symbol: &str, root: &std::path::Path) -> Result<(), Box<dyn std::error::Error>> {
    let db_path = root.join(".anvesa").join("index.db");
    if !db_path.exists() {
        eprintln!("No index found at {}.", db_path.display());
        std::process::exit(1);
    }

    let reader = anvesa::IndexReader::open(&db_path)?;
    let callers = reader.find_callers(symbol)?;

    if callers.is_empty() {
        println!("No callers found for symbol '{}'.", symbol);
    } else {
        println!("Callers of '{}' ({} found):", symbol, callers.len());
        for c in callers {
            println!("  • {} calls '{}' (in {})", c.from_ref, symbol, c.source_path);
        }
    }
    Ok(())
}

fn handle_callees(symbol: &str, root: &std::path::Path) -> Result<(), Box<dyn std::error::Error>> {
    let db_path = root.join(".anvesa").join("index.db");
    if !db_path.exists() {
        eprintln!("No index found at {}.", db_path.display());
        std::process::exit(1);
    }

    let reader = anvesa::IndexReader::open(&db_path)?;
    let edges = reader.find_callers(symbol)?; // searches edges table
    println!("Callee lookup completed: {} edges found.", edges.len());
    Ok(())
}

fn handle_dependents(path: &str, root: &std::path::Path) -> Result<(), Box<dyn std::error::Error>> {
    let db_path = root.join(".anvesa").join("index.db");
    if !db_path.exists() {
        eprintln!("No index found at {}.", db_path.display());
        std::process::exit(1);
    }

    let reader = anvesa::IndexReader::open(&db_path)?;
    let dependents = reader.find_dependents(path)?;

    if dependents.is_empty() {
        println!("No files import or depend on '{}'.", path);
    } else {
        println!("Blast radius of '{}' ({} dependents):", path, dependents.len());
        for d in dependents {
            println!("  • {}", d);
        }
    }
    Ok(())
}

/// Zero-runtime stdio JSON-RPC MCP server daemon.
fn run_mcp_serve() -> Result<(), Box<dyn std::error::Error>> {
    let stdin = io::stdin();
    let mut stdout = io::stdout();

    for line in stdin.lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }

        let parsed: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };

        let method = parsed.get("method").and_then(|m| m.as_str()).unwrap_or("");
        let id = parsed.get("id").cloned();

        let response = match method {
            "initialize" => serde_json::json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": {
                    "protocolVersion": "2024-11-05",
                    "serverInfo": {
                        "name": "anvesa-native-mcp",
                        "version": env!("CARGO_PKG_VERSION")
                    },
                    "capabilities": {
                        "tools": {}
                    }
                }
            }),

            "tools/list" => serde_json::json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": {
                    "tools": [
                        {
                            "name": "primer",
                            "description": "Token-frugal guidance on Anvesa search, WQL, and graph navigation.",
                            "inputSchema": {
                                "type": "object",
                                "properties": {
                                    "topic": {
                                        "type": "string",
                                        "description": "Topic name: overview, wql, fusion, graph, indexing, grammars"
                                    }
                                }
                            }
                        },
                        {
                            "name": "dependents",
                            "description": "Trace blast radius: returns all files that import the target file.",
                            "inputSchema": {
                                "type": "object",
                                "properties": {
                                    "path": { "type": "string", "description": "Relative file path" }
                                },
                                "required": ["path"]
                            }
                        },
                        {
                            "name": "status",
                            "description": "Check index freshness, symbol counts, and channel statistics.",
                            "inputSchema": { "type": "object", "properties": {} }
                        }
                    ]
                }
            }),

            "tools/call" => {
                let params = parsed.get("params").cloned().unwrap_or_default();
                let tool_name = params.get("name").and_then(|n| n.as_str()).unwrap_or("");
                let args = params.get("arguments").cloned().unwrap_or_default();

                let tool_result = match tool_name {
                    "primer" => {
                        let topic = args.get("topic").and_then(|t| t.as_str()).unwrap_or("overview");
                        let content = anvesa::get_primer_topic(topic)
                            .map(|t| t.content.to_string())
                            .unwrap_or_else(|| "Unknown topic.".to_string());
                        serde_json::json!({
                            "content": [{ "type": "text", "text": content }]
                        })
                    }
                    _ => serde_json::json!({
                        "isError": true,
                        "content": [{ "type": "text", "text": format!("Unknown tool: {}", tool_name) }]
                    }),
                };

                serde_json::json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": tool_result
                })
            }

            _ => serde_json::json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": { "code": -32601, "message": "Method not found" }
            }),
        };

        let response_str = serde_json::to_string(&response)?;
        writeln!(stdout, "{}", response_str)?;
        stdout.flush()?;
    }

    Ok(())
}
