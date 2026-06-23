class Horus < Formula
  desc "Local-first, source-aware incident investigation engine"
  homepage "https://horus.sh"
  version "0.1.2"
  license "MIT"

  depends_on "node"

  on_macos do
    on_arm do
      url "https://github.com/meritt-dev/horus/releases/download/v0.1.2/horus-v0.1.2-darwin-arm64.tar.gz"
      sha256 "e92be590cd40c9ccda4ad54c36e2e2e9bfabb3fe551d2f5db03a976a48171685"
    end
    on_intel do
      url "https://github.com/meritt-dev/horus/releases/download/v0.1.2/horus-v0.1.2-darwin-x86_64.tar.gz"
      sha256 "e92be590cd40c9ccda4ad54c36e2e2e9bfabb3fe551d2f5db03a976a48171685"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/meritt-dev/horus/releases/download/v0.1.2/horus-v0.1.2-linux-arm64.tar.gz"
      sha256 "e92be590cd40c9ccda4ad54c36e2e2e9bfabb3fe551d2f5db03a976a48171685"
    end
    on_intel do
      url "https://github.com/meritt-dev/horus/releases/download/v0.1.2/horus-v0.1.2-linux-x86_64.tar.gz"
      sha256 "e92be590cd40c9ccda4ad54c36e2e2e9bfabb3fe551d2f5db03a976a48171685"
    end
  end

  def install
    # The binary loads pglite's WASM/FS assets via `new URL('./pglite.wasm',
    # import.meta.url)`, which resolves relative to the binary's RESOLVED path. Install
    # the binary and its sibling assets together in libexec, then symlink into bin —
    # Node resolves the symlink before evaluating import.meta.url, so it finds the
    # siblings in libexec. (If the assets are absent, the CLI degrades to display-only.)
    libexec.install Dir["libexec/*"]
    bin.install_symlink libexec/"horus"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/horus --version")
    assert_match "Usage: horus", shell_output("#{bin}/horus --help")
  end
end
