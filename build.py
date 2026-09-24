import os
import hashlib
from datetime import datetime

def sha256_file(filepath):
    h = hashlib.sha256()
    with open(filepath, 'rb') as f:
        while chunk := f.read(8192):
            h.update(chunk)
    return h.hexdigest()

def build_appcache():
    base_dir = os.path.dirname(os.path.abspath(__file__))
    
    # Files to include in the offline cache manifest
    files_to_cache = [
        "index.html",
        "jb.html",
        "logo_RogueByte.png",
        "jb.js",
        "core.js",
        "mem.js",
        "int64.js",
        "ps4_offsets.js",
        "rpc_worker.js",
        "payload2.bin",
        "goldhen.bin",
        "patches/1302.bin",
        "patches/1350.bin",
        "patches/1352.bin",
    ]
    
    # Query param entries that point to existing files
    virtual_entries = [
        ("core.js?v=10", "core.js"),
        ("jb.js?v=10", "jb.js")
    ]
    
    timestamp = datetime.now().strftime("%Y%m%d-%H%M")
    rev_header = f"# rev {timestamp}-roguebyte-goldhen"
    
    lines = [
        "CACHE MANIFEST",
        rev_header,
        ""
    ]
    
    print("Building cache.appcache with updated SHA-256 hashes:")
    for rel_path in files_to_cache:
        full_path = os.path.join(base_dir, rel_path.replace("/", os.sep))
        if os.path.exists(full_path):
            file_hash = sha256_file(full_path)
            lines.append(f"{rel_path} #{file_hash}")
            print(f"  [+] {rel_path} -> {file_hash[:16]}...")
        else:
            print(f"  [!] Missing file skipped: {rel_path}")
            
    for entry_name, source_file in virtual_entries:
        full_path = os.path.join(base_dir, source_file.replace("/", os.sep))
        if os.path.exists(full_path):
            file_hash = sha256_file(full_path)
            lines.append(f"{entry_name} #{file_hash}")
            print(f"  [+] {entry_name} -> {file_hash[:16]}...")
            
    lines.extend([
        "",
        "NETWORK:",
        "*",
        "",
        "FALLBACK:",
        "index.html index.html",
        "jb.html jb.html",
        ""
    ])
    
    manifest_path = os.path.join(base_dir, "cache.appcache")
    with open(manifest_path, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(lines))
        
    print(f"\nSuccessfully generated {manifest_path} with revision {rev_header}")

if __name__ == "__main__":
    build_appcache()
