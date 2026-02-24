#!/bin/bash
# Generate test data for SFTP stress testing
# This runs at container build time to pre-populate the filesystem
set -e

BASE="/home/testuser/sftp-test"
mkdir -p "$BASE"

echo "=== Generating SFTP test data ==="

# --- Large files ---
echo "Creating large files..."
mkdir -p "$BASE/large-files"
# 1 MB file
dd if=/dev/urandom of="$BASE/large-files/1mb.bin" bs=1M count=1 2>/dev/null
# 10 MB file
dd if=/dev/urandom of="$BASE/large-files/10mb.bin" bs=1M count=10 2>/dev/null
# 100 MB file
dd if=/dev/urandom of="$BASE/large-files/100mb.bin" bs=1M count=100 2>/dev/null
# Empty file
touch "$BASE/large-files/empty.txt"
# Single byte
printf 'X' > "$BASE/large-files/single-byte.bin"

# --- Deep directory tree ---
echo "Creating deep directory tree..."
DEEP="$BASE/deep-tree"
CURRENT="$DEEP"
for i in $(seq 1 50); do
    CURRENT="$CURRENT/level-$i"
    mkdir -p "$CURRENT"
    echo "File at depth $i" > "$CURRENT/file.txt"
done

# --- Wide directory (many entries) ---
echo "Creating wide directory (1000 entries)..."
WIDE="$BASE/wide-dir"
mkdir -p "$WIDE"
for i in $(seq 1 1000); do
    printf "file-%04d content\n" "$i" > "$WIDE/$(printf 'file-%04d.txt' "$i")"
done

# --- Mixed content directory ---
echo "Creating mixed content..."
MIXED="$BASE/mixed"
mkdir -p "$MIXED"/{documents,images,scripts,data}
for i in $(seq 1 10); do
    echo "Document $i content" > "$MIXED/documents/doc-$i.txt"
    dd if=/dev/urandom of="$MIXED/images/image-$i.png" bs=1K count=$((RANDOM % 100 + 1)) 2>/dev/null
    echo "#!/bin/bash\necho script-$i" > "$MIXED/scripts/script-$i.sh"
    dd if=/dev/urandom of="$MIXED/data/data-$i.bin" bs=1K count=$((RANDOM % 500 + 1)) 2>/dev/null
done
chmod +x "$MIXED/scripts/"*.sh

# --- Symlinks ---
echo "Creating symlinks..."
LINKS="$BASE/symlinks"
mkdir -p "$LINKS"
echo "target content" > "$LINKS/target-file.txt"
mkdir -p "$LINKS/target-dir"
echo "inside target dir" > "$LINKS/target-dir/inner.txt"
ln -s "$LINKS/target-file.txt" "$LINKS/link-to-file"
ln -s "$LINKS/target-dir" "$LINKS/link-to-dir"
ln -s "/nonexistent/path" "$LINKS/broken-link"
# Circular symlink
ln -s "$LINKS/circular-b" "$LINKS/circular-a"
ln -s "$LINKS/circular-a" "$LINKS/circular-b"

# --- Permission scenarios ---
echo "Creating permission test files..."
PERMS="$BASE/permissions"
mkdir -p "$PERMS"
echo "readable" > "$PERMS/readable.txt"
chmod 444 "$PERMS/readable.txt"
echo "writable" > "$PERMS/writable.txt"
chmod 666 "$PERMS/writable.txt"
echo "executable" > "$PERMS/executable.sh"
chmod 755 "$PERMS/executable.sh"
echo "no-access" > "$PERMS/no-read.txt"
chmod 000 "$PERMS/no-read.txt"
mkdir -p "$PERMS/no-access-dir"
chmod 000 "$PERMS/no-access-dir"
# Sticky bit directory
mkdir -p "$PERMS/sticky-dir"
chmod 1777 "$PERMS/sticky-dir"

# --- Special filenames ---
echo "Creating special filename test files..."
SPECIAL="$BASE/special-names"
mkdir -p "$SPECIAL"
echo "spaces" > "$SPECIAL/file with spaces.txt"
echo "unicode" > "$SPECIAL/ünïcödë-fïlé.txt"
echo "dots" > "$SPECIAL/...multiple.dots..."
echo "dash" > "$SPECIAL/-starts-with-dash.txt"
echo "long" > "$SPECIAL/$(printf 'a%.0s' {1..200}).txt"
echo "hash" > "$SPECIAL/#hashtag.txt"
echo "at" > "$SPECIAL/@at-sign.txt"
echo "parens" > "$SPECIAL/(parentheses).txt"
echo "brackets" > "$SPECIAL/[brackets].txt"

# --- Hidden files ---
echo "Creating hidden files..."
HIDDEN="$BASE/hidden-files"
mkdir -p "$HIDDEN"
echo "visible" > "$HIDDEN/visible.txt"
echo "hidden" > "$HIDDEN/.hidden-file"
mkdir -p "$HIDDEN/.hidden-dir"
echo "in hidden dir" > "$HIDDEN/.hidden-dir/inside.txt"
echo "config" > "$HIDDEN/.config"

# Fix ownership
chown -R testuser:testuser "$BASE"

echo "=== SFTP test data generation complete ==="
echo "Total size: $(du -sh "$BASE" | cut -f1)"
