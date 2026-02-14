mod handler;
mod io;
mod protocol;
mod session;

use tracing::info;
use tracing_subscriber::EnvFilter;

const VERSION: &str = env!("CARGO_PKG_VERSION");

fn print_usage() {
    eprintln!("Usage: termihub-agent --stdio");
    eprintln!();
    eprintln!("Options:");
    eprintln!("  --stdio     Run in stdio mode (NDJSON over stdin/stdout)");
    eprintln!("  --version   Print version and exit");
    eprintln!("  --help      Print this help message");
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();

    if args.len() < 2 {
        print_usage();
        std::process::exit(1);
    }

    match args[1].as_str() {
        "--version" => {
            println!("termihub-agent {}", VERSION);
            Ok(())
        }
        "--help" => {
            print_usage();
            Ok(())
        }
        "--stdio" => {
            // Configure tracing to stderr so it doesn't interfere with the protocol on stdout
            tracing_subscriber::fmt()
                .with_env_filter(
                    EnvFilter::try_from_default_env()
                        .unwrap_or_else(|_| EnvFilter::new("info")),
                )
                .with_writer(std::io::stderr)
                .init();

            info!("termihub-agent {} starting in stdio mode", VERSION);
            io::stdio::run_stdio_loop().await
        }
        other => {
            eprintln!("Unknown option: {}", other);
            print_usage();
            std::process::exit(1);
        }
    }
}
