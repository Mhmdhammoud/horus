class Horus < Formula
  desc "Local-first, source-aware incident investigation engine"
  homepage "https://horus.sh"
  version "0.1.0"
  license "MIT"

  depends_on "node"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/meritt-dev/horus/releases/download/v0.1.0/horus-v0.1.0-darwin-arm64.tar.gz"
      sha256 "d854ece73ae0892f64a981cf46576f09f223661ab7e2f4e477513b5ca7f9a62a"
    else
      url "https://github.com/meritt-dev/horus/releases/download/v0.1.0/horus-v0.1.0-darwin-x86_64.tar.gz"
      sha256 "476926c0354f07f8c6e17ff60f59c5dd845a446430c333f26f0d1bcb2d044562"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "https://github.com/meritt-dev/horus/releases/download/v0.1.0/horus-v0.1.0-linux-arm64.tar.gz"
      sha256 "221d423f3b484a4979234be14597601751c60bfbd8d661301dba290b8dfa6ae6"
    else
      url "https://github.com/meritt-dev/horus/releases/download/v0.1.0/horus-v0.1.0-linux-x86_64.tar.gz"
      sha256 "ff2888067091952eec8b063d67d23607461bc46fa85ee17241aa4ee15af232c2"
    end
  end

  def install
    bin.install "bin/horus"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/horus --version")
    assert_match "Usage: horus", shell_output("#{bin}/horus --help")
  end
end
