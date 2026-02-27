"""安南将棋WebアプリのAPIサーバー.

Python標準ライブラリのみで実装。
起動: python3 server.py
ブラウザ: http://localhost:8080
"""

import json
import os
import sys
from http.server import HTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse

# エンジンのパスとAIのパスを追加
ENGINE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "Annan-Shogi")
AI_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "annan-shogi-ai")
sys.path.insert(0, ENGINE_DIR)
sys.path.insert(0, AI_DIR)

from annan_shogi import Game, Color, Move
from annan_shogi.core.piece import PieceType
from annan_shogi.rules.annan_rule import get_effective_piece_type
from annan_shogi.core.square import Square

# AIのインポート (PyTorch等が必要)
try:
    from player import AIPlayer
    from config import Config
    from model import AnnanNet
    import torch
    
    # AIの初期化 (モデルがあれば読み込み、なければランダムNN)
    ai_config = Config()
    ai_config.num_simulations = 50  # Web用は軽くする
    model_path = os.path.join(AI_DIR, "data", "models", "best_model.pt")
    if os.path.exists(model_path):
        ai_player = AIPlayer.load(model_path, ai_config)
        print("✅ 学習済みAIモデルを読み込みました")
    else:
        # ランダムNNで初期化
        ai_model = AnnanNet(ai_config)
        ai_model.eval()
        ai_model.to(ai_config.device)
        ai_player = AIPlayer(ai_model, ai_config)
        print("⚠️ 学習済みモデルが見つからないため、初期状態のAIを使用します")
except ImportError as e:
    print(f"⚠️ AIモジュールの読み込みに失敗しました: {e}")
    ai_player = None

# グローバルなゲームインスタンスと設定
game = Game()
ai_color = None  # None: PvP, "BLACK": AI先手, "WHITE": AI後手

# 駒種 → 漢字の対応表
_PIECE_KANJI = {
    "FU": "歩", "KY": "香", "KE": "桂", "GI": "銀",
    "KI": "金", "KA": "角", "HI": "飛", "OU": "玉",
    "TO": "と", "NY": "杏", "NK": "圭", "NG": "全",
    "UM": "馬", "RY": "龍",
}


_ZENKAKU_NUMS = ["", "１", "２", "３", "４", "５", "６", "７", "８", "９"]
_KANJI_NUMS = ["", "一", "二", "三", "四", "五", "六", "七", "八", "九"]

def _generate_kif_and_log() -> tuple[list[str], str]:
    """履歴からKIF文字列とログ用配列を生成する."""
    log_arr = []
    kif_lines = [
        "# KIF形式棋譜ファイル",
        "手合割：平手",
        "先手：プレイヤー",
        "後手：プレイヤー(またはAI)",
        "手数----指手---------消費時間--"
    ]
    
    prev_dst = None
    for i, m in enumerate(game._move_history):
        state = game._state_history[i]
        move_num = i + 1
        turn_mark = "☗" if state.turn is Color.BLACK else "☖"
        
        if m.is_drop:
            dst_f, dst_r = m.dst.file, m.dst.rank
            pc_str = _PIECE_KANJI[m.drop.value]
            
            move_str_kif = f"{_ZENKAKU_NUMS[dst_f]}{_KANJI_NUMS[dst_r]}{pc_str}打"
            move_str_log = f"{turn_mark}{_ZENKAKU_NUMS[dst_f]}{_KANJI_NUMS[dst_r]}{pc_str}打"
            prev_dst = m.dst
        else:
            pc = state.board[m.src]
            pc_str = _PIECE_KANJI[pc.piece_type.value]
            promote_str = "成" if m.promote else ""
            
            # 同判定
            if prev_dst and prev_dst == m.dst:
                dst_str = "同　"
            else:
                dst_str = f"{_ZENKAKU_NUMS[m.dst.file]}{_KANJI_NUMS[m.dst.rank]}"
                
            move_str_kif = f"{dst_str}{pc_str}{promote_str}({m.src.file}{m.src.rank})"
            
            # ログ用は絶対座標で分かりやすく
            move_str_log = f"{turn_mark}{_ZENKAKU_NUMS[m.dst.file]}{_KANJI_NUMS[m.dst.rank]}{pc_str}{promote_str}({m.src.file}{m.src.rank})"
            prev_dst = m.dst
            
        log_arr.append(move_str_log)
        kif_lines.append(f"{move_num:>4} {move_str_kif}")
        
    return log_arr, "\n".join(kif_lines)


def _game_state_to_json() -> dict:
    """現在のゲーム状態をJSON用の辞書に変換する."""
    state = game.state
    board_data = []
    annan_info = []  # 安南ルールによる実効駒種の情報

    for rank in range(9):
        row = []
        annan_row = []
        for file in range(9, 0, -1):
            sq = Square(file, rank)
            piece = state.board[sq]
            if piece is None:
                row.append(None)
                annan_row.append(None)
            else:
                row.append({
                    "type": piece.piece_type.value,
                    "kanji": _PIECE_KANJI[piece.piece_type.value],
                    "color": "BLACK" if piece.color is Color.BLACK else "WHITE",
                })
                # 安南ルールの実効駒種（王以外）
                if piece.piece_type is not PieceType.OU:
                    try:
                        eff = get_effective_piece_type(state.board, sq, piece.color)
                        if eff != piece.piece_type:
                            annan_row.append({
                                "effective_type": eff.value,
                                "effective_kanji": _PIECE_KANJI[eff.value],
                            })
                        else:
                            annan_row.append(None)
                    except Exception:
                        annan_row.append(None)
                else:
                    annan_row.append(None)
        board_data.append(row)
        annan_info.append(annan_row)

    # 合法手
    legal_moves = []
    if game.result.value == "ONGOING":
        for m in game.get_legal_moves():
            legal_moves.append(m.to_sfen())

    # 持ち駒
    black_hand = {pt.value: n for pt, n in game.stand(Color.BLACK).items()}
    white_hand = {pt.value: n for pt, n in game.stand(Color.WHITE).items()}

    # ログとKIF
    log_arr, kif_str = _generate_kif_and_log()

    return {
        "board": board_data,
        "annan_info": annan_info,
        "turn": str(game.turn),
        "black_hand": black_hand,
        "white_hand": white_hand,
        "legal_moves": legal_moves,
        "in_check": game.in_check(),
        "result": game.result.value,
        "ply": game.ply(),
        "ai_enabled": ai_player is not None,
        "ai_color": ai_color,
        "log": log_arr,
        "kif": kif_str,
    }


class AnnanHandler(SimpleHTTPRequestHandler):
    """安南将棋のAPIハンドラー."""

    def __init__(self, *args, **kwargs):
        # 静的ファイルのルートディレクトリをstaticに設定
        super().__init__(*args, directory=os.path.join(
            os.path.dirname(os.path.abspath(__file__)), "static"
        ), **kwargs)

    def do_GET(self):
        """GETリクエスト処理."""
        path = urlparse(self.path).path

        if path == "/api/state":
            self._json_response(_game_state_to_json())
        else:
            super().do_GET()

    def do_POST(self):
        """POSTリクエスト処理."""
        global game
        path = urlparse(self.path).path

        if path == "/api/move":
            body = self._read_body()
            sfen = body.get("move", "")
            try:
                game.apply(sfen)
                self._json_response(_game_state_to_json())
            except Exception as e:
                self._json_response({"error": str(e)}, status=400)

        elif path == "/api/undo":
            try:
                game.undo()
                self._json_response(_game_state_to_json())
            except Exception as e:
                self._json_response({"error": str(e)}, status=400)

        elif path == "/api/resign":
            game.resign()
            self._json_response(_game_state_to_json())

        elif path == "/api/reset":
            game = Game()
            self._json_response(_game_state_to_json())

        elif path == "/api/config":
            global ai_color
            body = self._read_body()
            ai_mode = body.get("ai_mode")
            if ai_mode == "black":
                ai_color = "BLACK"
            elif ai_mode == "white":
                ai_color = "WHITE"
            else:
                ai_color = None
            self._json_response({"status": "ok", "ai_color": ai_color})

        elif path == "/api/ai_move":
            if ai_player is None:
                self._json_response({"error": "AIが有効ではありません"}, status=400)
                return
            if game.result.value != "ONGOING":
                self._json_response({"error": "ゲーム終了済み"}, status=400)
                return
            
            # AIに思考させる
            move, _ = ai_player.select_move(game.state, temperature=0.0)
            if move is not None:
                game.apply(move)
            self._json_response(_game_state_to_json())

        else:
            self._json_response({"error": "不明なエンドポイント"}, status=404)

    def _read_body(self) -> dict:
        """リクエストボディをJSONとして読み取る."""
        length = int(self.headers.get("Content-Length", 0))
        if length == 0:
            return {}
        raw = self.rfile.read(length)
        return json.loads(raw.decode("utf-8"))

    def _json_response(self, data: dict, status: int = 200):
        """JSONレスポンスを返す."""
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(json.dumps(data, ensure_ascii=False).encode("utf-8"))

    def log_message(self, format, *args):
        """ログ出力を簡略化."""
        if "/api/" in str(args[0]):
            return  # APIリクエストのログは省略
        super().log_message(format, *args)


if __name__ == "__main__":
    port = 8080
    server = HTTPServer(("", port), AnnanHandler)
    print(f"安南将棋Webアプリ起動: http://localhost:{port}")
    print("終了するには Ctrl+C を押してください")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nサーバーを停止しました")
        server.server_close()
