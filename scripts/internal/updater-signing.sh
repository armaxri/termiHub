#!/usr/bin/env bash
#
# In-app updater signing helper for release.yml's sign-updater job (#5761).
#
# The updater private key (TAURI_SIGNING_PRIVATE_KEY + _PASSWORD) must never
# share a runner with third-party build code (npm lifecycle scripts, crate
# build.rs, tauri-action). build-app therefore builds and stages the updater
# bundles UNSIGNED, and a separate job that installs no project dependencies
# and compiles nothing signs them with this helper:
#
#   install-signer --out DIR
#       Download the pinned standalone Tauri CLI release binary for this host
#       (updater-signer.json), refuse it unless its SHA-256 matches the pin,
#       extract it into DIR and print the binary's path. Uses GH_TOKEN /
#       GITHUB_TOKEN for the download when set (fetch-github-release-asset.sh).
#
#   sign --signer BIN --version V --app-version S --dir DIR [--digests DIR2]
#        [--config FILE]
#       Sign every updater bundle of release V in DIR (the names come from
#       updater-platforms.json via `updater-manifest.mjs assets`). With
#       --digests, every bundle must first match a `<sha256>  <name>` line of a
#       *.sha256 file in DIR2 (the digests build-app wrote when it staged it).
#       Each <bundle>.sig is bound to app version S (minisign trusted comment
#       `version:S`, what `requireSignedVersion` checks). Afterwards every .sig
#       is verified against the public key in --config (default
#       src-tauri/tauri.updater.conf.json). The key comes only from the
#       TAURI_SIGNING_PRIVATE_KEY / TAURI_SIGNING_PRIVATE_KEY_PASSWORD
#       environment variables, never argv; nothing prints key material.
#
# Exit status: 0 ok, 1 failure, 2 bad arguments.
# See docs/contributing.md -> "In-App Updater".

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PIN_FILE="$SCRIPT_DIR/updater-signer.json"
MANIFEST_TOOL="$SCRIPT_DIR/updater-manifest.mjs"
FETCH="$SCRIPT_DIR/fetch-github-release-asset.sh"

die() {
    echo "updater-signing: $*" >&2
    exit 1
}

usage_error() {
    echo "updater-signing: $*" >&2
    echo "usage: $0 install-signer --out DIR | sign --signer BIN --version V --app-version S --dir DIR [--digests DIR] [--config FILE]" >&2
    exit 2
}

sha256_of() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | cut -d' ' -f1
    else
        shasum -a 256 "$1" | cut -d' ' -f1
    fi
}

# pin <node expression over `p` (the parsed pin file)>
pin() {
    node -e 'const p = require(process.argv[1]); console.log(eval(process.argv[2]) ?? "");' \
        "$PIN_FILE" "$1"
}

host_key() {
    local os arch
    os="$(uname -s)"
    arch="$(uname -m)"
    case "$os/$arch" in
    Linux/x86_64) echo linux-x86_64 ;;
    Darwin/arm64) echo darwin-arm64 ;;
    Darwin/x86_64) echo darwin-x86_64 ;;
    *) die "no pinned Tauri CLI asset for $os/$arch in $PIN_FILE" ;;
    esac
}

cmd_install_signer() {
    local out=""
    while [ "$#" -gt 0 ]; do
        case "$1" in
        --out)
            [ "$#" -ge 2 ] || usage_error "--out needs a directory"
            out="$2"
            shift 2
            ;;
        *) usage_error "unknown option: $1" ;;
        esac
    done
    [ -n "$out" ] || usage_error "--out is required"

    local key repo version tag name want binary
    key="$(host_key)"
    repo="$(pin 'p.repo')"
    version="$(pin 'p.version')"
    tag="$(pin 'p.tag.replaceAll("{version}", p.version)')"
    name="$(pin "p.assets['$key']?.name")"
    want="$(pin "p.assets['$key']?.sha256")"
    binary="$(pin 'p.binary')"
    [ -n "$name" ] && [[ "$want" =~ ^[0-9a-f]{64}$ ]] || die "bad pin for $key in $PIN_FILE"

    mkdir -p "$out"
    local work
    work="$(mktemp -d)"
    # shellcheck disable=SC2064 # expand $work now: it is local to this function.
    trap "rm -rf '$work'" EXIT
    "$FETCH" "$repo" "$tag" "$name" "$work/$name" >&2
    local got
    got="$(sha256_of "$work/$name")"
    [ "$got" = "$want" ] ||
        die "$name has SHA-256 $got, expected the pinned $want; refusing to run it"
    mkdir "$work/x"
    case "$name" in
    *.tgz | *.tar.gz) tar -xzf "$work/$name" -C "$work/x" "$binary" ;;
    *.zip) unzip -q "$work/$name" "$binary" -d "$work/x" ;;
    *) die "unknown archive type: $name" ;;
    esac
    [ -f "$work/x/$binary" ] || die "$name holds no $binary"
    install -m 0755 "$work/x/$binary" "$out/$binary"
    echo "Tauri CLI $version ($name, SHA-256 verified) -> $out/$binary" >&2
    echo "$out/$binary"
}

cmd_sign() {
    local signer="" version="" app_version="" dir="" digests="" config=""
    while [ "$#" -gt 0 ]; do
        [ "$#" -ge 2 ] || usage_error "$1 needs a value"
        case "$1" in
        --signer) signer="$2" ;;
        --version) version="$2" ;;
        --app-version) app_version="$2" ;;
        --dir) dir="$2" ;;
        --digests) digests="$2" ;;
        --config) config="$2" ;;
        *) usage_error "unknown option: $1" ;;
        esac
        shift 2
    done
    [ -n "$signer" ] && [ -n "$version" ] && [ -n "$app_version" ] && [ -n "$dir" ] ||
        usage_error "--signer, --version, --app-version and --dir are required"
    [ -x "$signer" ] || die "signer $signer is not executable"
    [ -d "$dir" ] || die "$dir is not a directory"
    [ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ] || die "TAURI_SIGNING_PRIVATE_KEY is not set"
    config="${config:-$REPO_ROOT/src-tauri/tauri.updater.conf.json}"

    local assets=()
    local line
    while IFS= read -r line; do
        assets+=("$line")
    done < <(node "$MANIFEST_TOOL" assets --version "$version")
    [ "${#assets[@]}" -gt 0 ] || die "no updater bundles defined for $version"

    local asset
    if [ -n "$digests" ]; then
        local sums
        sums="$(cat "$digests"/*.sha256 2>/dev/null)" || die "no *.sha256 digests in $digests"
        for asset in "${assets[@]}"; do
            local want got
            want="$(awk -v n="$asset" '$2 == n || $2 == "*" n { print $1 }' <<<"$sums")"
            [ -n "$want" ] || die "no digest for $asset in $digests"
            [ -f "$dir/$asset" ] || die "$asset is not in $dir"
            got="$(sha256_of "$dir/$asset")"
            [ "$got" = "$want" ] ||
                die "$asset has SHA-256 $got, but build-app staged $want; refusing to sign it"
        done
        echo "All ${#assets[@]} updater bundles match the digests build-app staged."
    fi

    for asset in "${assets[@]}"; do
        [ -f "$dir/$asset" ] || die "$asset is not in $dir"
        rm -f "$dir/$asset.sig"
        # The key and password reach the signer through its environment only.
        "$signer" signer sign --app-version "$app_version" "$dir/$asset" >/dev/null ||
            die "signing $asset failed"
        [ -s "$dir/$asset.sig" ] || die "the signer wrote no $asset.sig"
        echo "Signed $asset (version $app_version)."
    done

    node "$MANIFEST_TOOL" verify --version "$version" --signed-version "$app_version" \
        --dir "$dir" --config "$config"
}

case "${1:-}" in
install-signer)
    shift
    cmd_install_signer "$@"
    ;;
sign)
    shift
    cmd_sign "$@"
    ;;
--help | -h)
    sed -n '3,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    ;;
*) usage_error "command must be install-signer or sign" ;;
esac
