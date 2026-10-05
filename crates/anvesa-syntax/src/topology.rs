//! How a grammar's node types occur in real code: the statistics `mapping train`, `audit` and
//! `refine` learn from. A port of `inspectTopology` in `structural/src/training.ts`.
//!
//! Counts keep the order keys were first seen, as JavaScript `Map`s do: the learner breaks ties
//! by that order, so the same samples must give the same order here.

use serde::ser::{SerializeMap, SerializeSeq};
use serde::{Serialize, Serializer};
use std::collections::{HashMap, HashSet};
use tree_sitter::{Node, Parser};

/// Counts by key, in first-seen order. Serialised as `[[key, count], ...]`.
#[derive(Debug, Clone, Default)]
pub struct Counts {
    keys: Vec<String>,
    index: HashMap<String, usize>,
    counts: Vec<u32>,
}

impl Counts {
    fn bump(&mut self, key: &str) {
        match self.index.get(key) {
            Some(&at) => self.counts[at] += 1,
            None => {
                self.index.insert(key.to_string(), self.keys.len());
                self.keys.push(key.to_string());
                self.counts.push(1);
            }
        }
    }
}

impl Serialize for Counts {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut seq = serializer.serialize_seq(Some(self.keys.len()))?;
        for (key, count) in self.keys.iter().zip(&self.counts) {
            seq.serialize_element(&(key, count))?;
        }
        seq.end()
    }
}

/// Field name to the child types that filled it, in first-seen order.
#[derive(Debug, Clone, Default)]
pub struct FieldCounts {
    order: Vec<String>,
    by_field: HashMap<String, Counts>,
}

impl FieldCounts {
    fn bump(&mut self, field: &str, child: &str) {
        if !self.by_field.contains_key(field) {
            self.order.push(field.to_string());
        }
        self.by_field
            .entry(field.to_string())
            .or_default()
            .bump(child);
    }
}

impl Serialize for FieldCounts {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut seq = serializer.serialize_seq(Some(self.order.len()))?;
        for field in &self.order {
            seq.serialize_element(&(field, &self.by_field[field]))?;
        }
        seq.end()
    }
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct TypeStats {
    pub count: u32,
    pub files: u32,
    pub fields: FieldCounts,
    pub parents: Counts,
    pub ancestors: Counts,
    pub children: Counts,
}

#[derive(Debug, Clone)]
pub struct Topology {
    pub language: String,
    pub samples: u32,
    pub nodes: u32,
    pub types: Vec<(String, TypeStats)>,
    pub with_syntax_errors: Vec<String>,
}

impl Serialize for Topology {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(5))?;
        map.serialize_entry("language", &self.language)?;
        map.serialize_entry("samples", &self.samples)?;
        map.serialize_entry("nodes", &self.nodes)?;
        map.serialize_entry("types", &self.types)?;
        map.serialize_entry("withSyntaxErrors", &self.with_syntax_errors)?;
        map.end()
    }
}

/// Parse each sample and record, for every kind of named node, which fields it fills and with
/// what, what it sits in, and how many samples it occurs in. `None` without a compiled grammar.
pub fn inspect_topology(language: &str, samples: &[(String, String)]) -> Option<Topology> {
    let grammar = crate::get_tree_sitter_language(language)?;
    let mut parser = Parser::new();
    parser.set_language(&grammar).ok()?;

    let mut order: Vec<String> = Vec::new();
    let mut types: HashMap<String, TypeStats> = HashMap::new();
    let mut with_syntax_errors = Vec::new();
    let mut nodes = 0u32;

    for (path, source) in samples {
        let tree = parser.parse(source, None)?;
        if tree.root_node().has_error() {
            with_syntax_errors.push(path.clone());
        }
        let mut seen: HashSet<&'static str> = HashSet::new();
        // Types open on the current path, with how many times, in first-opened order.
        let mut open: Vec<(&'static str, u32)> = Vec::new();
        let mut path_types: Vec<&'static str> = Vec::new();
        enum Frame<'t> {
            Enter(Node<'t>, Option<Node<'t>>),
            Exit,
        }
        let mut stack = vec![Frame::Enter(tree.root_node(), None)];
        while let Some(frame) = stack.pop() {
            let (node, parent) = match frame {
                Frame::Exit => {
                    let kind = path_types.pop().expect("an entered node is exited once");
                    if let Some(at) = open.iter().position(|(k, _)| *k == kind) {
                        open[at].1 -= 1;
                        if open[at].1 == 0 {
                            open.remove(at);
                        }
                    }
                    continue;
                }
                Frame::Enter(node, parent) => (node, parent),
            };
            if node.is_error() || node.is_missing() {
                continue;
            }
            nodes += 1;
            let kind = node.kind();
            if !types.contains_key(kind) {
                order.push(kind.to_string());
            }
            let stats = types.entry(kind.to_string()).or_default();
            stats.count += 1;
            if seen.insert(kind) {
                stats.files += 1;
            }
            if let Some(parent) = parent {
                stats.parents.bump(parent.kind());
            }
            for (ancestor, _) in &open {
                stats.ancestors.bump(ancestor);
            }

            path_types.push(kind);
            match open.iter_mut().find(|(k, _)| *k == kind) {
                Some(entry) => entry.1 += 1,
                None => open.push((kind, 1)),
            }
            stack.push(Frame::Exit);

            let mut children = Vec::new();
            for index in 0..node.child_count() {
                let Some(child) = node.child(index) else {
                    continue;
                };
                if !child.is_named() {
                    continue;
                }
                let stats = types.get_mut(kind).expect("just counted");
                stats.children.bump(child.kind());
                if let Some(field) = node.field_name_for_child(index as u32) {
                    stats.fields.bump(field, child.kind());
                }
                children.push(Frame::Enter(child, Some(node)));
            }
            stack.extend(children.into_iter().rev());
        }
    }

    let types = order
        .into_iter()
        .map(|kind| {
            let stats = types.remove(&kind).expect("every ordered type has stats");
            (kind, stats)
        })
        .collect();
    Some(Topology {
        language: language.to_string(),
        samples: samples.len() as u32,
        nodes,
        types,
        with_syntax_errors,
    })
}
