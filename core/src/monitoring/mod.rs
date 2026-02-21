//! Monitoring types and parsers shared between the desktop and agent crates.

pub mod parser;
pub mod types;

pub use parser::{
    cpu_percent_from_delta, parse_cpu_line, parse_df_output, parse_meminfo_value, parse_stats,
    MONITORING_COMMAND,
};
pub use types::{CpuCounters, SystemStats};
