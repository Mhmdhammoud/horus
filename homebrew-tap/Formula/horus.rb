class Horus < Formula
  desc "Local-first, source-aware incident investigation engine"
  homepage "https://horus.sh"
  version "0.1.0"
  license "MIT"

  depends_on "node"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/meritt-dev/horus/releases/download/v0.1.0/horus-v0.1.0-darwin-arm64.tar.gz"
      sha256 "eaf305bc26b19fe4a56e83ddb6a6934c043d5efd879e596c1aa24b0a252a8c94"
    else
      url "https://github.com/meritt-dev/horus/releases/download/v0.1.0/horus-v0.1.0-darwin-x86_64.tar.gz"
      sha256 "0c774a28456b1f6e2c10057114746e094cec839e129bbb2879378d1a59007202"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "https://github.com/meritt-dev/horus/releases/download/v0.1.0/horus-v0.1.0-linux-arm64.tar.gz"
      sha256 "15ff3cbf76602f28ca6b3b7e2e1117ee987caf9967f3f402ff21caaddcd110e7"
    else
      url "https://github.com/meritt-dev/horus/releases/download/v0.1.0/horus-v0.1.0-linux-x86_64.tar.gz"
      sha256 "091b96ab11a6b9328657ba8dae83830c2772996baf6063ce279f478d09538e51"
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
