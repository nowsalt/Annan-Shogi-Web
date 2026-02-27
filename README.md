# 安南将棋 Web

ブラウザで遊べる安南将棋。

## 起動方法

```bash
python3 server.py
# http://localhost:8080 を開く
```

## 構成

- `server.py` — APIサーバー (Python標準ライブラリのみ)
- `static/` — フロントエンド (HTML/CSS/JS)
- エンジン: [Annan-Shogi](https://github.com/nowsalt/Annan-Shogi) を利用
