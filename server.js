const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

let rooms = {};

function createDeck() {
    const suits = ['Srdce', 'Kule', 'Zeleně', 'Žaludy'];
    const values = ['7', '8', '9', '10', 'Spodek', 'Svršek', 'Král', 'Eso'];
    let deck = [];
    for (let s of suits) for (let v of values) deck.push({ suit: s, value: v });
    return deck.sort(() => Math.random() - 0.5);
}

// Upravená inicializace hry se střídáním začínajícího hráče
function initGame(game, isRestart = false) {
    game.deck = createDeck();
    game.pile = [game.deck.pop()];
    
    // Logika střídání startu
    if (!isRestart) {
        game.starterIndex = 0; // První hra začíná hráč 0
    } else {
        game.starterIndex = (game.starterIndex + 1) % game.players.length; // Posun na dalšího
    }
    
    game.turn = game.starterIndex;
    game.winner = null;
    game.penalty = 0;
    game.skip = 0;
    game.requestedSuit = null;
    game.waitingForSuit = false;
    
    game.players.forEach(p => {
        p.hand = game.deck.splice(0, 4);
        p.ready = false;
    });
}

function broadcastGameState(roomId, lastAction = null) {
    const game = rooms[roomId];
    if (!game || !game.players.length) return;
    const turnId = game.players[game.turn] ? game.players[game.turn].id : null;

    io.in(roomId).fetchSockets().then(sockets => {
        sockets.forEach(socket => {
            const playersInfo = game.players.map(p => ({
                id: p.id,
                name: p.name,
                handCount: p.hand.length,
                hand: p.id === socket.id ? p.hand : [],
                ready: p.ready,
                score: p.score
            }));
            socket.emit('gameState', { ...game, players: playersInfo, turnId, lastAction });
        });
    });
}

io.on('connection', (socket) => {
    socket.on('joinRoom', ({ roomId, playerName }) => {
        socket.join(roomId);
        socket.roomId = roomId;
        if (!rooms[roomId]) {
            rooms[roomId] = { players: [], starterIndex: 0 };
        }
        const game = rooms[roomId];
        
        if (game.players.length < 4 && !game.players.find(p => p.id === socket.id)) {
            let startingHand = [];
            if (game.deck && game.deck.length > 4 && !game.winner) startingHand = game.deck.splice(0, 4);
            
            game.players.push({ 
                id: socket.id, 
                name: playerName.trim() || `Hráč ${game.players.length + 1}`, 
                hand: startingHand, 
                ready: false, 
                score: 0 
            });
            
            if (game.players.length >= 2 && (!game.deck || game.winner)) initGame(game, false);
        }
        broadcastGameState(roomId);
    });

    socket.on('playCard', ({ roomId, cardIndex }) => {
        const game = rooms[roomId];
        if (!game || game.winner || !game.players[game.turn] || game.players[game.turn].id !== socket.id || game.waitingForSuit) return;
        const player = game.players[game.turn];
        const card = player.hand[cardIndex];
        const top = game.pile[game.pile.length - 1];

        if (game.penalty > 0 && card.value !== '7') return;
        if (game.skip > 0 && card.value !== 'Eso') return;

        if (card.value === 'Svršek' || (game.requestedSuit ? card.suit === game.requestedSuit : (card.suit === top.suit || card.value === top.value))) {
            const played = player.hand.splice(cardIndex, 1)[0];
            game.pile.push(played);
            game.requestedSuit = null;
            if (played.value === '7') game.penalty += 2;
            if (played.value === 'Eso') game.skip += 1;
            
            if (player.hand.length === 0) {
                game.winner = socket.id;
                player.score += 1;
            }
            else if (played.value === 'Svršek') game.waitingForSuit = true;
            else game.turn = (game.turn + 1) % game.players.length;
            broadcastGameState(roomId, { type: 'play', playerId: socket.id, card: played, cardIndex });
        }
    });

    socket.on('drawCard', (roomId) => {
        const game = rooms[roomId];
        if (!game || !game.players[game.turn] || game.players[game.turn].id !== socket.id || game.waitingForSuit) return;
        
        let type = 'draw';
        let count = 0;
        if (game.skip > 0) {
            game.skip = 0;
            type = 'skip';
        } else {
            count = game.penalty > 0 ? game.penalty : 1;
            game.penalty = 0;
            for (let i = 0; i < count; i++) {
                if (game.deck.length === 0) {
                    const t = game.pile.pop();
                    game.deck = game.pile.sort(() => Math.random() - 0.5);
                    game.pile = [t];
                }
                game.players[game.turn].hand.push(game.deck.pop());
            }
        }
        game.turn = (game.turn + 1) % game.players.length;
        broadcastGameState(roomId, { type, playerId: socket.id, count });
    });

    socket.on('chooseSuit', ({ roomId, suit }) => {
        const game = rooms[roomId];
        if (game && game.waitingForSuit && game.players[game.turn].id === socket.id) {
            game.requestedSuit = suit; game.waitingForSuit = false;
            game.turn = (game.turn + 1) % game.players.length;
            broadcastGameState(roomId);
        }
    });

    socket.on('restartRequest', (roomId) => {
        const game = rooms[roomId];
        if (game) {
            const p = game.players.find(p => p.id === socket.id);
            if (p) p.ready = true;
            // Restartujeme hru pouze když jsou všichni ready
            if (game.players.every(p => p.ready) && game.players.length >= 2) initGame(game, true);
            broadcastGameState(roomId);
        }
    });

    socket.on('disconnect', () => {
        if (socket.roomId && rooms[socket.roomId]) {
            rooms[socket.roomId].players = rooms[socket.roomId].players.filter(p => p.id !== socket.id);
            if (rooms[socket.roomId].players.length === 0) delete rooms[socket.roomId];
            else broadcastGameState(socket.roomId);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server běží na portu ${PORT}`));
