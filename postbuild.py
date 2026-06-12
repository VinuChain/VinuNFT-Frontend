from pathlib import Path


if __name__ == "__main__":
    public_dir = Path("public")
    legacy_php_files = [
        public_dir / "social.php",
        public_dir / "Keccak.php",
        public_dir / "nft" / "index.php",
        public_dir / "nft" / "Keccak.php",
    ]

    for legacy_file in legacy_php_files:
        if legacy_file.exists():
            legacy_file.unlink()

    print("Finished postprocessing without PHP social preview output.")
