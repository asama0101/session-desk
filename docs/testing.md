# テストの実行

テストは `session-desk/hooks/*.test.tsx` にある。Claude Code の `claude-code/testing` を使うので、Claude Code の外（`bun test` など）では動かない。

リポジトリのルートで、次のコマンドを実行する。Claude Code が入っている環境が要る。

```bash
claude plugin test session-desk
```

最後に `N pass` と `0 fail` が出れば成功。マニフェスト（`plugin.json`）の確認は、次のコマンドで行う。

```bash
claude plugin validate session-desk
```

CI（GitHub Actions）は置いていない。PR を出す前に、手元で上の 2 つを実行する。
