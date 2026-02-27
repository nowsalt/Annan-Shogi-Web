/**
 * 安南将棋Webアプリ — フロントエンドロジック
 *
 * サーバーAPIと通信して盤面を描画し、
 * クリック操作で駒の移動・打ちを行う。
 */

// --- 状態管理 ---
let gameState = null;       // サーバーから取得した最新状態
let selectedCell = null;    // 選択中のマス { file, rank }
let selectedHand = null;    // 選択中の持ち駒 { color, type }
let pendingMove = null;     // 成り選択待ちの手 { src, dst }
let isAiThinking = false;   // AI思考中フラグ

// 筋 (file): 配列index 0 = 9筋, 8 = 1筋
const fileFromIndex = (i) => 9 - i;
const indexFromFile = (f) => 9 - f;

// SFEN座標変換
const RANK_CHARS = 'abcdefghi';
const toSfen = (file, rank) => `${file}${RANK_CHARS[rank]}`;

// 駒種 → SFEN文字
const PIECE_TO_SFEN = {
    FU: 'P', KY: 'L', KE: 'N', GI: 'S',
    KI: 'G', KA: 'B', HI: 'R', OU: 'K',
};

// --- API通信 ---

async function fetchState() {
    const res = await fetch('/api/state');
    gameState = await res.json();
    const select = document.getElementById('ai-mode');
    if (!gameState.ai_enabled) {
        select.disabled = true;
        select.title = "AIモジュールがロードされていません";
    } else {
        if (gameState.ai_color === 'BLACK') select.value = 'black';
        else if (gameState.ai_color === 'WHITE') select.value = 'white';
        else select.value = 'none';
    }
    render();
    checkAiTurn();
}

async function sendMove(sfenMove) {
    const res = await fetch('/api/move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ move: sfenMove }),
    });
    gameState = await res.json();
    clearSelection();
    render();
    checkResult();
    checkAiTurn();
}

async function doUndo() {
    const res = await fetch('/api/undo', { method: 'POST' });
    gameState = await res.json();
    clearSelection();
    render();
    checkAiTurn();
}

async function doResign() {
    if (!confirm('投了しますか？')) return;
    const res = await fetch('/api/resign', { method: 'POST' });
    gameState = await res.json();
    render();
    checkResult();
}

async function doReset() {
    const res = await fetch('/api/reset', { method: 'POST' });
    gameState = await res.json();
    clearSelection();
    render();
    checkAiTurn();
}

// --- 描画 ---

function render() {
    renderBoard();
    renderHand('black');
    renderHand('white');
    renderStatus();
}

// --- AI関連 ---

async function changeAiMode() {
    const select = document.getElementById('ai-mode');
    const ai_mode = select.value;
    const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ai_mode }),
    });
    const data = await res.json();
    gameState.ai_color = data.ai_color;
    checkAiTurn();
}

async function checkAiTurn() {
    if (!gameState || gameState.result !== 'ONGOING') return;
    if (gameState.ai_color && gameState.turn === gameState.ai_color) {
        isAiThinking = true;
        render(); // "AI思考中" を表示

        try {
            const res = await fetch('/api/ai_move', { method: 'POST' });
            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.error || "API HTTP Error");
            }
            gameState = await res.json();
        } catch (e) {
            console.error("AI move failed", e);
            alert("AIの手の取得に失敗しました: " + e.message);
        } finally {
            isAiThinking = false;
            clearSelection();
            render();
            checkResult();
            // もしAI同士の対戦モードなどがあれば再帰的に呼ばれる（ここではない想定）
        }
    }
}

function renderBoard() {
    const boardEl = document.getElementById('board');
    boardEl.innerHTML = '';

    for (let rank = 0; rank < 9; rank++) {
        for (let col = 0; col < 9; col++) {
            const file = fileFromIndex(col);
            const cell = document.createElement('div');
            cell.className = 'cell';
            cell.dataset.file = file;
            cell.dataset.rank = rank;

            const piece = gameState.board[rank][col];
            if (piece) {
                const span = document.createElement('span');
                span.className = `piece ${piece.color.toLowerCase()}`;
                span.textContent = piece.kanji;
                cell.appendChild(span);
                cell.classList.add('has-piece');
            }

            // 安南ルールで変化中の駒
            const annan = gameState.annan_info[rank][col];
            if (annan) {
                cell.classList.add('annan-active');
                cell.title = `安南: ${annan.effective_kanji}の動き`;
            }

            // 選択状態
            if (selectedCell && selectedCell.file === file && selectedCell.rank === rank) {
                cell.classList.add('selected');
            }

            // 合法手ハイライト
            if (isLegalTarget(file, rank)) {
                cell.classList.add('legal-target');
            }

            cell.addEventListener('click', () => onCellClick(file, rank, piece));
            boardEl.appendChild(cell);
        }
    }
}

function renderHand(color) {
    const handEl = document.getElementById(`${color}-hand`);
    handEl.innerHTML = '';

    const handData = color === 'black' ? gameState.black_hand : gameState.white_hand;
    const HAND_ORDER = ['HI', 'KA', 'KI', 'GI', 'KE', 'KY', 'FU'];
    const KANJI = { FU: '歩', KY: '香', KE: '桂', GI: '銀', KI: '金', KA: '角', HI: '飛' };

    for (const pt of HAND_ORDER) {
        const count = handData[pt] || 0;
        if (count === 0) continue;

        const el = document.createElement('div');
        el.className = `hand-piece ${color}`;
        el.textContent = KANJI[pt];

        if (count > 1) {
            const countEl = document.createElement('span');
            countEl.className = 'count';
            countEl.textContent = count;
            el.appendChild(countEl);
        }

        // 選択状態
        if (selectedHand && selectedHand.color === color.toUpperCase() && selectedHand.type === pt) {
            el.classList.add('selected');
        }

        // 自分の手番のみクリック可能
        const isTurn = gameState.turn === color.toUpperCase();
        if (isTurn) {
            el.addEventListener('click', () => onHandClick(color.toUpperCase(), pt));
        } else {
            el.style.opacity = '0.5';
            el.style.cursor = 'default';
        }

        handEl.appendChild(el);
    }
}

function renderStatus() {
    const statusEl = document.getElementById('status');
    const plyEl = document.getElementById('ply-count');
    const checkEl = document.getElementById('check-indicator');

    if (gameState.result !== 'ONGOING') {
        const resultMap = {
            BLACK_WIN: '☗ 先手の勝ち',
            WHITE_WIN: '☖ 後手の勝ち',
            DRAW: '引き分け',
        };
        statusEl.textContent = resultMap[gameState.result] || gameState.result;
    } else if (isAiThinking) {
        statusEl.textContent = '💻 AI思考中...';
        statusEl.style.color = 'var(--accent)';
    } else {
        statusEl.textContent = gameState.turn === 'BLACK' ? '☗ 先手の番' : '☖ 後手の番';
        statusEl.style.color = 'var(--text-muted)';
    }

    plyEl.textContent = `${gameState.ply}手目`;

    if (gameState.in_check) {
        checkEl.classList.remove('hidden');
    } else {
        checkEl.classList.add('hidden');
    }
}

// --- クリックイベント ---

function onCellClick(file, rank, piece) {
    if (gameState.result !== 'ONGOING' || isAiThinking) return;

    // 持ち駒を選択中 → 打つ先を選択
    if (selectedHand) {
        if (isLegalTarget(file, rank)) {
            const sfenChar = PIECE_TO_SFEN[selectedHand.type];
            const move = `${sfenChar}*${toSfen(file, rank)}`;
            sendMove(move);
        } else {
            clearSelection();
            render();
        }
        return;
    }

    // 駒を選択中 → 移動先を選択
    if (selectedCell) {
        if (isLegalTarget(file, rank)) {
            tryMove(selectedCell.file, selectedCell.rank, file, rank);
        } else if (piece && piece.color === gameState.turn) {
            // 自分の別の駒を選択し直し
            selectedCell = { file, rank };
            render();
        } else {
            clearSelection();
            render();
        }
        return;
    }

    // 駒を選択
    if (piece && piece.color === gameState.turn) {
        selectedCell = { file, rank };
        render();
    }
}

function onHandClick(color, pieceType) {
    if (gameState.result !== 'ONGOING' || isAiThinking) return;
    if (color !== gameState.turn) return;

    if (selectedHand && selectedHand.type === pieceType) {
        clearSelection();
    } else {
        selectedCell = null;
        selectedHand = { color, type: pieceType };
    }
    render();
}

// --- 移動処理 ---

function tryMove(srcFile, srcRank, dstFile, dstRank) {
    const srcSfen = toSfen(srcFile, srcRank);
    const dstSfen = toSfen(dstFile, dstRank);

    // 成りと不成りの両方が合法手にあるか確認
    const promoteMove = `${srcSfen}${dstSfen}+`;
    const noPromoteMove = `${srcSfen}${dstSfen}`;

    const canPromote = gameState.legal_moves.includes(promoteMove);
    const canNoPromote = gameState.legal_moves.includes(noPromoteMove);

    if (canPromote && canNoPromote) {
        // 成り選択ダイアログを表示
        pendingMove = { src: srcSfen, dst: dstSfen };
        document.getElementById('promote-dialog').classList.remove('hidden');
    } else if (canPromote) {
        sendMove(promoteMove);
    } else if (canNoPromote) {
        sendMove(noPromoteMove);
    }
}

function confirmPromotion(promote) {
    document.getElementById('promote-dialog').classList.add('hidden');
    if (pendingMove) {
        const move = `${pendingMove.src}${pendingMove.dst}${promote ? '+' : ''}`;
        pendingMove = null;
        sendMove(move);
    }
}

// --- 合法手判定 ---

function isLegalTarget(file, rank) {
    if (!gameState) return false;
    const dst = toSfen(file, rank);

    if (selectedCell) {
        const src = toSfen(selectedCell.file, selectedCell.rank);
        return gameState.legal_moves.some(m =>
            m.startsWith(`${src}${dst}`)
        );
    }

    if (selectedHand) {
        const ch = PIECE_TO_SFEN[selectedHand.type];
        return gameState.legal_moves.includes(`${ch}*${dst}`);
    }

    return false;
}

// --- ユーティリティ ---

function clearSelection() {
    selectedCell = null;
    selectedHand = null;
    pendingMove = null;
}

function checkResult() {
    if (gameState.result !== 'ONGOING') {
        const resultMap = {
            BLACK_WIN: '☗ 先手の勝ち！',
            WHITE_WIN: '☖ 後手の勝ち！',
            DRAW: '引き分け',
        };
        document.getElementById('result-text').textContent =
            resultMap[gameState.result] || gameState.result;
        document.getElementById('result-dialog').classList.remove('hidden');
    }
}

// --- 初期化 ---
fetchState();
