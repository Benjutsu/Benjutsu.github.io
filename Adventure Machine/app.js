// Adventure Machine clone logique principale
// ------------------------------------------
// Objectif: 6x6 boutons (rotés de 45° visuellement) → 10 DRUM, 10 BASS, 16 SOUND.
// Contrainte de lecture simultanée: 1 DRUM, 1 BASS, 3 SOUND.
// Boucles synchronisées sur un cycle commun. Un clic pendant la lecture aligne au prochain cycle.

// NOTE IMPORTANTE: Le dossier fourni contient des fichiers .asd (métadonnées Ableton) et peu/pas de .wav.
// Pour que les pads jouent réellement quelque chose, ajoutez les fichiers .wav correspondants (même nom sans .asd).

const SAMPLE_DIR = 'Madeon Adventure Machine Samples v2/'; // chemin relatif

// Génère les noms attendus. Adaptez si vos fichiers diffèrent.
const sampleNames = {
	drum: Array.from({ length: 10 }, (_, i) => `drum.1.${i + 1}.wav`),
	bass: Array.from({ length: 10 }, (_, i) => `bass.1.${i + 1}.wav`),
	sound: Array.from({ length: 16 }, (_, i) => `sounds.1.${i + 1}.wav`)
};

const limits = { drum: 1, bass: 1, sound: 3 };
let audioCtx;
let buffers = {}; // key -> AudioBuffer (si trouvé)

// État dynamique
let playing = { drum: [], bass: [], sound: [] }; // [{key, startedCycle}]
let pending = { drum: [], bass: [], sound: [] }; // mêmes objets en attente prochain cycle
let disabledAtNext = new Set(); // keys à retirer (stop manuel)

let cycleDuration = null; // secondes
let lastCycleStart = null; // audioCtx time du cycle actuel
let cycleTimer = null; // interval visuel / maintenance
// Sources actives pour arrêt instantané
const activeSources = {}; // key -> AudioBufferSourceNode
// BPM visuel (synchro esthétique)
const BPM = 110;
let __viz = null; // visualizer state
let __vizAmp = 0; // smoothed amplitude 0..1 for background pulse
let __lastBeatIndex = -1; // beat tracker for pad rotations
// Progress bar elements
const progressBar = document.getElementById('cycleProgress');
const progressFill = document.getElementById('cycleProgressFill');

const gridEl = document.getElementById('grid');
const stopAllBtn = document.getElementById('stopAll');
const vizDrumCanvas = document.getElementById('vizDrum2D');
const vizBassCanvas = document.getElementById('vizBass2D');

// Audio routing graph per category
const categoryNodes = { drum: null, bass: null, sound: null };
// Per-sound dedicated analysers to drive 3D rings (max 3 sounds)
const perSoundAnalysers = {}; // key -> AnalyserNode

// ============================================
// EFFETS AUDIO - Nodes globaux
// ============================================
let masterGain = null;
let reverbNode = null;
let reverbGain = null;
let dryGain = null;
let delayNode = null;
let delayFeedback = null;
let delayGain = null;
let filterNode = null;

// Pitch Shifter nodes
let pitchShifterNode = null;
let pitchShifterInput = null;
let pitchMod1 = null, pitchMod2 = null;
let pitchDelay1 = null, pitchDelay2 = null;
let pitchGain1 = null, pitchGain2 = null;

// Paramètres d'effets
const effectParams = {
	masterVolume: 1,
	reverbMix: 0,
	delayMix: 0,
	delayTime: 0.3,
	filterFreq: 20000,
	filterQ: 1,
	pitchShift: 0,
	playbackRate: 1
};

// ============================================
// ENREGISTREMENT
// ============================================
let mediaRecorder = null;
let recordedChunks = [];
let recordingStartTime = null;
let recordingTimer = null;
let recordingDestination = null;

// ============================================
// PRESETS
// ============================================
const PRESETS_STORAGE_KEY = 'adventureMachine_presets';

// Positioning layout for triangular grouping:
// 6x6 grid coordinates (row, col)
// Bass triangle (left) and Drum triangle (right) explicit positions.
const bassPositions = [
	[1,3],[1,4],[1,5],[1,6],[2,4],[2,5],[2,6],[3,5],[3,6],[4,6]
];
const drumPositions = [
	[3,1],[4,1],[4,2],[5,1],[5,2],[5,3],[6,1],[6,2],[6,3],[6,4]
];

// Compute remaining central cells for sounds (all cells minus bass+drum positions)
function computeSoundPositions() {
	const used = new Set([...bassPositions, ...drumPositions].map(p => p.join('-')));
	const sounds = [];
	for (let r=1; r<=6; r++) {
		for (let c=1; c<=6; c++) {
			const key = r+"-"+c;
			if (!used.has(key)) sounds.push([r,c]);
		}
	}
	return sounds; // length should be 16
}
const soundPositions = computeSoundPositions();

function ensureCtx() {
	if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
	if (audioCtx.state === 'suspended') audioCtx.resume();
	ensureGraph();
	ensureEffectsGraph();
}

function ensureGraph() {
	if (!audioCtx) return;
	for (const cat of ['drum', 'bass', 'sound']) {
		if (!categoryNodes[cat]) {
			const gain = audioCtx.createGain();
			gain.gain.value = 1.0;
			const analyser = audioCtx.createAnalyser();
			analyser.fftSize = 256;
			analyser.smoothingTimeConstant = 0.85;
			// Route: analyser -> gain -> (effects chain via ensureEffectsGraph)
			analyser.connect(gain);
			// Connection to effects chain happens in ensureEffectsGraph
			categoryNodes[cat] = { gain, analyser };
		}
	}
}

// ============================================
// CRÉATION DU GRAPHE D'EFFETS
// ============================================
function ensureEffectsGraph() {
	if (!audioCtx || masterGain) return; // Déjà créé
	
	// Master Gain (volume final)
	masterGain = audioCtx.createGain();
	masterGain.gain.value = effectParams.masterVolume;
	
	// Créer le Pitch Shifter (granular technique)
	createPitchShifter();
	
	// Filtre passe-bas
	filterNode = audioCtx.createBiquadFilter();
	filterNode.type = 'lowpass';
	filterNode.frequency.value = effectParams.filterFreq;
	filterNode.Q.value = effectParams.filterQ;
	
	// Delay
	delayNode = audioCtx.createDelay(2.0);
	delayNode.delayTime.value = effectParams.delayTime;
	delayFeedback = audioCtx.createGain();
	delayFeedback.gain.value = 0.4; // Feedback amount
	delayGain = audioCtx.createGain();
	delayGain.gain.value = effectParams.delayMix;
	
	// Delay routing: delay -> feedback -> delay (loop), delay -> delayGain
	delayNode.connect(delayFeedback);
	delayFeedback.connect(delayNode);
	delayNode.connect(delayGain);
	
	// Reverb (convolution avec IR généré)
	reverbNode = audioCtx.createConvolver();
	reverbGain = audioCtx.createGain();
	reverbGain.gain.value = effectParams.reverbMix;
	dryGain = audioCtx.createGain();
	dryGain.gain.value = 1 - effectParams.reverbMix;
	
	// Générer une réponse impulsionnelle pour la reverb
	createReverbIR(2.5, 2); // 2.5 secondes, decay rate 2
	
	// Routing: reverbNode -> reverbGain
	reverbNode.connect(reverbGain);
	
	// Destination pour l'enregistrement
	recordingDestination = audioCtx.createMediaStreamDestination();
	
	// Connecter les catégories au graphe d'effets
	// categoryGain -> pitchShifter -> filterNode -> dryGain -> masterGain -> destination
	//                                           -> delayNode
	//                                           -> reverbNode -> reverbGain -> masterGain
	
	for (const cat of ['drum', 'bass', 'sound']) {
		if (categoryNodes[cat]) {
			categoryNodes[cat].gain.disconnect();
			categoryNodes[cat].gain.connect(pitchShifterInput);
		}
	}
	
	// Pitch Shifter -> Filter
	pitchShifterNode.connect(filterNode);
	
	// Filter -> dry path + effects sends
	filterNode.connect(dryGain);
	filterNode.connect(delayNode);
	filterNode.connect(reverbNode);
	
	// Mix tous vers master
	dryGain.connect(masterGain);
	delayGain.connect(masterGain);
	reverbGain.connect(masterGain);
	
	// Master -> destination + recording
	masterGain.connect(audioCtx.destination);
	masterGain.connect(recordingDestination);
}

// ============================================
// PITCH SHIFTER - Simple Delay Modulation
// ============================================
// Technique simplifiée : modulation de délai avec deux voies en opposition de phase
// pour un crossfade naturel sans oscillation de volume

function createPitchShifter() {
	if (!audioCtx) return;
	
	const grainSize = 0.05; // 50ms - taille du grain plus petite pour moins d'artefacts
	const bufferTime = 0.2; // Buffer de 200ms
	
	// Input node
	pitchShifterInput = audioCtx.createGain();
	pitchShifterInput.gain.value = 1;
	
	// Output node
	pitchShifterNode = audioCtx.createGain();
	pitchShifterNode.gain.value = 1;
	
	// Deux delay lines
	pitchDelay1 = audioCtx.createDelay(bufferTime);
	pitchDelay2 = audioCtx.createDelay(bufferTime);
	
	// Gains fixes pour le mixage (pas de modulation du gain!)
	pitchGain1 = audioCtx.createGain();
	pitchGain2 = audioCtx.createGain();
	pitchGain1.gain.value = 0.5;
	pitchGain2.gain.value = 0.5;
	
	// Oscillateurs pour moduler UNIQUEMENT le delay time (sawtooth)
	pitchMod1 = audioCtx.createOscillator();
	pitchMod2 = audioCtx.createOscillator();
	pitchMod1.type = 'sawtooth';
	pitchMod2.type = 'sawtooth';
	
	// Gain nodes pour scaler la modulation du délai
	const modGain1 = audioCtx.createGain();
	const modGain2 = audioCtx.createGain();
	modGain1.gain.value = 0;
	modGain2.gain.value = 0;
	
	// Offset constant pour centrer le délai
	const delayOffset1 = audioCtx.createConstantSource();
	const delayOffset2 = audioCtx.createConstantSource();
	delayOffset1.offset.value = grainSize;
	delayOffset2.offset.value = grainSize * 1.5; // Décalé pour le crossfade
	
	// Connecter : oscillateur -> modGain -> delayTime
	//             offset constant -> delayTime (additionné)
	pitchMod1.connect(modGain1);
	pitchMod2.connect(modGain2);
	modGain1.connect(pitchDelay1.delayTime);
	modGain2.connect(pitchDelay2.delayTime);
	delayOffset1.connect(pitchDelay1.delayTime);
	delayOffset2.connect(pitchDelay2.delayTime);
	
	// Signal path: input -> delays -> gains (fixes) -> output
	pitchShifterInput.connect(pitchDelay1);
	pitchShifterInput.connect(pitchDelay2);
	pitchDelay1.connect(pitchGain1);
	pitchDelay2.connect(pitchGain2);
	pitchGain1.connect(pitchShifterNode);
	pitchGain2.connect(pitchShifterNode);
	
	// Démarrer les oscillateurs et sources constantes
	pitchMod1.start();
	pitchMod2.start();
	delayOffset1.start();
	delayOffset2.start();
	
	// Stocker les références pour les mises à jour
	pitchShifterNode._modGain1 = modGain1;
	pitchShifterNode._modGain2 = modGain2;
	pitchShifterNode._delayOffset1 = delayOffset1;
	pitchShifterNode._delayOffset2 = delayOffset2;
	pitchShifterNode._grainSize = grainSize;
	
	// Initialiser à pitch = 0
	updatePitchShifter(0);
}

function updatePitchShifter(semitones) {
	if (!audioCtx || !pitchMod1 || !pitchShifterNode) return;
	
	const grainSize = pitchShifterNode._grainSize || 0.05;
	const t = audioCtx.currentTime;
	
	// Si pitch = 0, désactiver la modulation
	if (semitones === 0) {
		pitchMod1.frequency.setValueAtTime(0.001, t);
		pitchMod2.frequency.setValueAtTime(0.001, t);
		
		if (pitchShifterNode._modGain1) {
			pitchShifterNode._modGain1.gain.setValueAtTime(0, t);
			pitchShifterNode._modGain2.gain.setValueAtTime(0, t);
		}
		return;
	}
	
	// Calcul du ratio de pitch
	const pitchRatio = Math.pow(2, semitones / 12);
	
	// La fréquence de modulation détermine la vitesse de "lecture"
	// Pour un pitch shift vers le haut, on "raccourcit" virtuellement le délai
	// Pour un pitch shift vers le bas, on "allonge" le délai
	const modFreq = Math.abs(1 - pitchRatio) / grainSize;
	
	// Limiter la fréquence pour éviter les artefacts
	const clampedFreq = Math.min(Math.max(modFreq, 0.5), 50);
	
	// Profondeur de modulation (combien le délai varie)
	const modDepth = grainSize * 0.4;
	
	// Direction de la modulation selon le sens du pitch
	const direction = semitones > 0 ? -1 : 1;
	
	// Appliquer les paramètres
	pitchMod1.frequency.setValueAtTime(clampedFreq, t);
	pitchMod2.frequency.setValueAtTime(clampedFreq, t);
	
	if (pitchShifterNode._modGain1) {
		pitchShifterNode._modGain1.gain.setValueAtTime(modDepth * direction, t);
		pitchShifterNode._modGain2.gain.setValueAtTime(modDepth * direction, t);
	}
}

// Génère une réponse impulsionnelle pour la reverb
function createReverbIR(duration, decay) {
	if (!audioCtx) return;
	const sampleRate = audioCtx.sampleRate;
	const length = sampleRate * duration;
	const impulse = audioCtx.createBuffer(2, length, sampleRate);
	
	for (let channel = 0; channel < 2; channel++) {
		const channelData = impulse.getChannelData(channel);
		for (let i = 0; i < length; i++) {
			// Bruit blanc avec decay exponentiel
			channelData[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
		}
	}
	
	if (reverbNode) {
		reverbNode.buffer = impulse;
	}
}

// Construction UI ---------------------------------
function buildGrid() {
	// Create pads for each category and assign explicit grid positions.
	// Bass
	sampleNames.bass.forEach((name, i) => {
		const [row,col] = bassPositions[i];
		createPad('bass', name, row, col);
	});
	// Drum
	sampleNames.drum.forEach((name, i) => {
		const [row,col] = drumPositions[i];
		createPad('drum', name, row, col);
	});
	// Sound (central leftover)
	sampleNames.sound.forEach((name, i) => {
		const [row,col] = soundPositions[i];
		createPad('sound', name, row, col);
	});
}

function createPad(cat, name, row, col) {
	const pad = document.createElement('button');
	pad.className = `pad ${cat}`;
	pad.type = 'button';
	pad.dataset.key = name;
	pad.dataset.category = cat;
	pad.style.gridRow = row;
	pad.style.gridColumn = col;
	pad.innerHTML = `<span>${labelFor({cat, name})}</span>`;
	pad.addEventListener('click', () => onPadClick(pad));
	gridEl.appendChild(pad);
}

function labelFor(item) {
	if (item.cat === 'drum') return 'DR ' + numberFromName(item.name, 'drum.1.');
	if (item.cat === 'bass') return 'BA ' + numberFromName(item.name, 'bass.1.');
	return 'SD ' + numberFromName(item.name, 'sounds.1.');
}
function numberFromName(name, prefix) {
	return name.startsWith(prefix) ? name.slice(prefix.length, name.indexOf('.wav')) : '?';
}

// Chargement audio (best effort) ------------------
async function loadAllBuffers() {
	ensureCtx();
	const all = [...sampleNames.drum, ...sampleNames.bass, ...sampleNames.sound];
	for (const name of all) {
		try {
			const res = await fetch(SAMPLE_DIR + name);
			if (!res.ok) { markMissing(name); continue; }
			const arr = await res.arrayBuffer();
			buffers[name] = await audioCtx.decodeAudioData(arr);
			if (!cycleDuration) cycleDuration = buffers[name].duration; // prend la première comme durée maître
		} catch (e) {
			markMissing(name);
		}
	}
	if (!cycleDuration) cycleDuration = 4; // fallback arbitraire 4s si rien chargé
}

function markMissing(name) {
	const pad = gridEl.querySelector(`[data-key="${CSS.escape(name)}"]`);
	if (pad) pad.classList.add('missing');
}

// Interaction pads --------------------------------
function onPadClick(pad) {
	// Interaction même si sample manquant (sera silencieux)
	ensureCtx();
	const key = pad.dataset.key;
	const cat = pad.dataset.category;

	// Arrêt instantané si en lecture
	if (pad.classList.contains('playing')) {
		if (activeSources[key]) {
			try { activeSources[key].stop(); } catch(e) {}
			delete activeSources[key];
		}
		playing[cat] = playing[cat].filter(o => o.key !== key);
		disabledAtNext.delete(key);
		pad.classList.remove('playing');
		resetPadRotation(pad);
		return;
	}
	// Annuler si en file d'attente
	if (pad.classList.contains('queued')) {
		pending[cat] = pending[cat].filter(o => o.key !== key);
		pad.classList.remove('queued');
		return;
	}

	// Ajout nouveau
	const info = { key, cat, addedAt: audioCtx.currentTime };
	
	if (!anyPlaying()) { // démarrer un nouveau cycle direct
		startNewCycle([info]);
		return;
	}

	// Si la catégorie est pleine (ex: 3 sounds jouent), on met en file d'attente
	// Le remplacement se fera à la prochaine transition de cycle
	if (playing[cat].length >= limits[cat]) {
		// On peut mettre en file autant de pads qu'il y a de slots dans la catégorie
		// (chaque pad en file remplacera un pad actif à la transition)
		// Si la file est déjà pleine, on évince le plus ancien de la file
		while (pending[cat].length >= limits[cat]) {
			const dropped = pending[cat].shift();
			const droppedPad = gridEl.querySelector(`[data-key="${CSS.escape(dropped.key)}"]`);
			if (droppedPad) droppedPad.classList.remove('queued');
		}
		pending[cat].push(info);
		pad.classList.add('queued');
		return;
	}

	// Catégorie pas encore pleine: on ajoute aussi en file d'attente
	// pour synchroniser au prochain cycle
	// Capacité restante = limite - (actifs + déjà en file)
	const totalPending = playing[cat].length + pending[cat].length;
	if (totalPending >= limits[cat]) {
		// File pleine, évince le plus ancien en file
		while (pending[cat].length > 0 && playing[cat].length + pending[cat].length >= limits[cat]) {
			const dropped = pending[cat].shift();
			const droppedPad = gridEl.querySelector(`[data-key="${CSS.escape(dropped.key)}"]`);
			if (droppedPad) droppedPad.classList.remove('queued');
		}
	}
	pending[cat].push(info);
	pad.classList.add('queued');
}

function anyPlaying() { return playing.drum.length || playing.bass.length || playing.sound.length; }

// Calcule la durée effective du cycle en tenant compte de la vitesse UNIQUEMENT
// Le pitch shift ne doit PAS affecter la durée du cycle
function getEffectiveCycleDuration() {
	if (!cycleDuration) return 4;
	// Seul le playbackRate affecte la durée du cycle, pas le pitch
	return cycleDuration / effectParams.playbackRate;
}

// Cycle & scheduling ------------------------------
function startNewCycle(initial = []) {
	if (!cycleDuration) cycleDuration = inferDuration(initial) || 4;
	lastCycleStart = audioCtx.currentTime + 0.05; // petit décalage pour planifier proprement
	replaceCycleSets(initial);
	scheduleCycle(lastCycleStart);
	launchCycleLoop();
}

function inferDuration(list) {
	for (const it of list) {
		if (buffers[it.key]) return buffers[it.key].duration;
	}
	return null;
}

function replaceCycleSets(initial) {
	playing = { drum: [], bass: [], sound: [] };
	initial.forEach(it => playing[it.cat].push({ key: it.key, startedCycle: 0 }));
}

function scheduleCycle(startTime) {
	// (Ré)joue tous les buffers actifs
	for (const cat of Object.keys(playing)) {
		for (const obj of playing[cat]) {
			if (disabledAtNext.has(obj.key)) continue; // ignoré
			const buf = buffers[obj.key];
			if (!buf) continue; // sample absent
			const src = audioCtx.createBufferSource();
			src.buffer = buf;
			
			// Appliquer uniquement le playbackRate (la vitesse)
			// Le pitch est géré séparément par le pitch shifter granulaire
			src.playbackRate.value = effectParams.playbackRate;
			
			// Connect buffer source to graph
			ensureGraph();
			if (cat === 'sound') {
				// Route through a dedicated analyser per sound, then into category analyser
				let ana = perSoundAnalysers[obj.key];
				if (!ana) {
					ana = audioCtx.createAnalyser();
					ana.fftSize = 256;
					ana.smoothingTimeConstant = 0.82;
					perSoundAnalysers[obj.key] = ana;
					// chain dedicated analyser to category sound analyser once
					ana.connect(categoryNodes.sound.analyser);
				}
				src.connect(ana);
			} else {
				// Drum/bass unchanged
				src.connect(categoryNodes[cat].analyser);
			}
			src.start(startTime);
			activeSources[obj.key] = src;
			src.onended = () => { if (activeSources[obj.key] === src) delete activeSources[obj.key]; };
			obj.startedCycle = (obj.startedCycle || 0) + 1;
		}
	}
	updatePadClasses();
}

function updatePadClasses() {
	// Déterminer les clés actives (à afficher comme playing)
	const activeKeys = new Set();
	for (const cat of Object.keys(playing)) {
		for (const obj of playing[cat]) {
			if (!disabledAtNext.has(obj.key)) activeKeys.add(obj.key);
		}
	}
	// Retirer playing et resetter la rotation pour les inactifs
	gridEl.querySelectorAll('.pad').forEach(p => {
		const key = p.dataset.key;
		if (!activeKeys.has(key)) {
			p.classList.remove('playing');
			resetPadRotation(p);
		}
	});
	// Appliquer playing sur les actifs
	activeKeys.forEach(key => {
		const pad = gridEl.querySelector(`[data-key="${CSS.escape(key)}"]`);
		if (pad) pad.classList.add('playing');
	});
}

// Helpers de rotation des pads (90° par pulsation BPM)
function resetPadRotation(pad) {
	pad.dataset.rotStep = '0';
	pad.style.transform = '';
	const span = pad.querySelector('span');
	if (span) span.style.transform = 'rotate(-45deg)';
}

function stepPadRotation(pad) {
	const cur = parseInt(pad.dataset.rotStep || '0', 10) || 0;
	const next = (cur + 1) % 4;
	pad.dataset.rotStep = String(next);
	const angle = next * 90; // rotation horaire
	pad.style.transform = `rotate(${angle}deg)`;
	const span = pad.querySelector('span');
	if (span) span.style.transform = `rotate(${-45 - angle}deg)`; // garder label lisible
}
function launchCycleLoop() {
	if (cycleTimer) clearInterval(cycleTimer);
	cycleTimer = setInterval(() => {
		if (!lastCycleStart || !cycleDuration) return;
		const now = audioCtx.currentTime;
		const effectiveDuration = getEffectiveCycleDuration();
		const nextStart = lastCycleStart + effectiveDuration;
		// Approche lookahead: planifier légèrement avant la fin actuelle
		if (now >= nextStart - 0.12) {
			advanceCycle(nextStart);
		}
	}, 40); // 25–50ms check
	// démarrer rendu progress si non lancé
	if (!window.__progressRAF) {
		window.__progressRAF = true;
		requestAnimationFrame(updateProgressVisual);
	}
}

function advanceCycle(nextStart) {
	// Retire ceux demandés en arrêt
	for (const cat of Object.keys(playing)) {
		playing[cat] = playing[cat].filter(o => !disabledAtNext.has(o.key));
	}
	disabledAtNext.clear();
	
	// Ajoute les pending en respectant limites
	// Si la catégorie est pleine, on remplace les plus anciens (FIFO)
	for (const cat of Object.keys(pending)) {
		if (!pending[cat].length) continue;
		
		for (const add of pending[cat]) {
			// Si la catégorie est pleine, retirer le plus ancien pour faire de la place
			if (playing[cat].length >= limits[cat]) {
				const removed = playing[cat].shift();
				if (removed && activeSources[removed.key]) {
					try { activeSources[removed.key].stop(); } catch(e) {}
					delete activeSources[removed.key];
				}
				const oldPad = gridEl.querySelector(`[data-key="${CSS.escape(removed.key)}"]`);
				if (oldPad) {
					oldPad.classList.remove('playing', 'queued');
					resetPadRotation(oldPad);
				}
			}
			
			// Ajouter le nouveau
			playing[cat].push({ key: add.key, startedCycle: 0 });
			const pad = gridEl.querySelector(`[data-key="${CSS.escape(add.key)}"]`);
			if (pad) pad.classList.remove('queued');
		}
		pending[cat] = [];
	}
	lastCycleStart = nextStart;
	scheduleCycle(nextStart);
}

// STOP GLOBAL -------------------------------------
function stopAll() {
	playing = { drum: [], bass: [], sound: [] };
	pending = { drum: [], bass: [], sound: [] };
	disabledAtNext.clear();
	for (const k of Object.keys(activeSources)) {
		try { activeSources[k].stop(); } catch(e) {}
		delete activeSources[k];
	}
	// clear per-sound analysers registry (nodes will be GC'ed when disconnected sources end)
	for (const k of Object.keys(perSoundAnalysers)) delete perSoundAnalysers[k];
	lastCycleStart = null;
	if (cycleTimer) { clearInterval(cycleTimer); cycleTimer = null; }
	gridEl.querySelectorAll('.pad').forEach(p => { p.classList.remove('playing', 'queued'); resetPadRotation(p); });
	if (progressFill) progressFill.style.width = '0%';
}
stopAllBtn.addEventListener('click', stopAll);

// Initialisation ----------------------------------
buildGrid();
loadAllBuffers(); // lancer sans await; pas bloquant
window.addEventListener('pointerdown', ensureCtx, { once: true });

// ----------------------------------------------
// 3D BPM Visualizer (Three.js)
// ----------------------------------------------
function initBPMVisualizer() {
	if (!window.THREE) return; // sécurité si CDN indispo
	const THREE = window.THREE;
	const scene = new THREE.Scene();
	const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 100);
	camera.position.set(0, 0, 4.2);

	const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
	renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
	renderer.setSize(window.innerWidth, window.innerHeight);
	renderer.domElement.style.position = 'fixed';
	renderer.domElement.style.inset = '0';
	renderer.domElement.style.zIndex = '0';
	renderer.domElement.style.pointerEvents = 'none';
	if (document.body.firstChild) {
		document.body.insertBefore(renderer.domElement, document.body.firstChild);
	} else {
		document.body.appendChild(renderer.domElement);
	}

	// Lights
	const amb = new THREE.AmbientLight(0xffffff, 0.55);
	scene.add(amb);
	const dir = new THREE.DirectionalLight(0xffffff, 0.6);
	dir.position.set(2, 3, 2);
	scene.add(dir);

	// Helper to create a spectrum ring (torus + bars extruding toward camera)
	function makeSpectrumRing({ radius, color, bars = 64 }) {
		const group = new THREE.Group();
		// Base torus ring (in XY plane faces camera)
		const torusGeom = new THREE.TorusGeometry(radius, 0.045, 18, 180);
		const torusMat = new THREE.MeshStandardMaterial({
			color: new THREE.Color(color),
			emissive: new THREE.Color(color),
			emissiveIntensity: 0.18,
			metalness: 0.25,
			roughness: 0.4
		});
		const torus = new THREE.Mesh(torusGeom, torusMat);
		group.add(torus);
		// Bar geometry extrudes toward camera (along +Z). Origin at base (z=0)
		const barGeom = new THREE.BoxGeometry(0.035, 0.035, 1);
		barGeom.translate(0, 0, 0.5);
		const barMat = new THREE.MeshStandardMaterial({
			color: new THREE.Color(color),
			emissive: new THREE.Color(color),
			emissiveIntensity: 0.25,
			metalness: 0.2,
			roughness: 0.45
		});
		const barsMeshes = [];
		for (let i=0;i<bars;i++) {
			const phi = (i / bars) * Math.PI * 2;
			const x = Math.cos(phi) * radius;
			const y = Math.sin(phi) * radius;
			const m = new THREE.Mesh(barGeom, barMat);
			m.position.set(x, y, 0);
			m.rotation.z = phi; // orient width along tangent (cosmetic)
			m.scale.set(1, 1, 0.01); // start tiny on Z (toward viewer)
			group.add(m);
			barsMeshes.push(m);
		}
		return { group, torus, barsMeshes, barMat, torusMat, radius };
	}

	// Color for sounds (3 rings for up to 3 concurrent sounds)
	const soundColor = getCssVar('--sound') || '#5bc0ff';
	const ringSound0 = makeSpectrumRing({ radius: 0.78, color: soundColor, bars: 72 });
	const ringSound1 = makeSpectrumRing({ radius: 1.02, color: soundColor, bars: 72 });
	const ringSound2 = makeSpectrumRing({ radius: 1.28, color: soundColor, bars: 72 });
	scene.add(ringSound2.group);
	scene.add(ringSound1.group);
	scene.add(ringSound0.group);

	// Grid plane (very subtle)
	const grid = new THREE.GridHelper(10, 20, 0x22324f, 0x1b2742);
	grid.material.opacity = 0.25;
	grid.material.transparent = true;
	grid.position.y = -1.2;
	scene.add(grid);

	const clock = new THREE.Clock();

	// Smooth arrays per ring
	function ensureSmooth(arr, len) {
		if (!arr || arr.length !== len) return new Array(len).fill(0);
		return arr;
	}
	let smoothBass, smoothDrum, smoothSound;
	function render() {
		const isPlaying = anyPlaying();
		// BPM-locked gentle breath scale for all rings
		let aTarget = 0;
		if (isPlaying && audioCtx && lastCycleStart != null) {
			const beatDur = 60 / BPM; // seconds per beat
			const t = Math.max(0, audioCtx.currentTime - lastCycleStart);
			const phase = (t % beatDur) / beatDur; // 0..1 within current beat
			aTarget = 0.5 * (1 + Math.sin(phase * Math.PI * 2));
		}
		const dt = clock.getDelta();
		const tau = 0.12;
		const alpha = 1 - Math.exp(-dt / tau);
		__vizAmp += (aTarget - __vizAmp) * alpha;
		const a = __vizAmp;
		const s0 = 1 + a * 0.20;
		const s1 = 1 + a * 0.18;
		const s2 = 1 + a * 0.16;
		ringSound0.group.scale.set(s0, s0, s0);
		ringSound1.group.scale.set(s1, s1, s1);
		ringSound2.group.scale.set(s2, s2, s2);

		// Update bars from per-sound analysers for up to 3 concurrent sounds
		ensureGraph();
		const rings = [ringSound0, ringSound1, ringSound2];
		const keys = playing.sound
			.filter(o => !disabledAtNext.has(o.key))
			.slice(0, 3)
			.map(o => o.key);
		for (let r=0;r<3;r++) {
			const ring = rings[r];
			const key = keys[r];
			if (!key || !perSoundAnalysers[key]) {
				// idle look
				for (const m of ring.barsMeshes) m.scale.z = 0.01;
				ring.torusMat.emissiveIntensity = 0.1;
				ring.barMat.emissiveIntensity = 0.1;
				continue;
			}
			const an = perSoundAnalysers[key];
			const arr = new Uint8Array(an.frequencyBinCount);
			an.getByteFrequencyData(arr);
			const n = ring.barsMeshes.length;
			const gamma = 1.15;
			let vmax = 0, mean = 0;
			for (let i=0;i<n;i++) {
				const idx = Math.floor((i / (n-1)) * (arr.length-1));
				const v = arr[idx] / 255;
				if (v > vmax) vmax = v;
				mean += v;
			}
			mean /= n;
			const nor = vmax > 1e-4 ? (1 / vmax) : 1;
			if (!ring.__smooth || ring.__smooth.length !== n) ring.__smooth = new Array(n).fill(0);
			for (let i=0;i<n;i++) {
				const idx = Math.floor((i / (n-1)) * (arr.length-1));
				const v = Math.pow(Math.min(1, (arr[idx] / 255) * nor), gamma);
				ring.__smooth[i] = ring.__smooth[i] * 0.78 + v * 0.22;
				const h = 0.06 + ring.__smooth[i] * 1.8; // grow toward camera
				ring.barsMeshes[i].scale.z = h;
			}
			const amp = Math.min(1, mean / 0.25);
			ring.torusMat.emissiveIntensity = isPlaying ? (0.18 + amp * 0.9) : 0.12 * amp;
			ring.barMat.emissiveIntensity = isPlaying ? (0.25 + amp * 1.1) : 0.15 * amp;
		}

		renderer.render(scene, camera);
		requestAnimationFrame(render);
	}
	render();

	function onResize() {
		camera.aspect = window.innerWidth / window.innerHeight;
		camera.updateProjectionMatrix();
		renderer.setSize(window.innerWidth, window.innerHeight);
	}
	window.addEventListener('resize', onResize);

	__viz = { scene, camera, renderer, rings: [ringSound0, ringSound1, ringSound2], clock, onResize };
}

// Lancer le visualizer
initBPMVisualizer();

// UI: progress bar updater
function updateProgressVisual() {
	try {
		const any = anyPlaying();
		if (!any || !audioCtx || !lastCycleStart || !cycleDuration) {
			if (progressFill) progressFill.style.width = '0%';
			__lastBeatIndex = -1;
		} else {
			const effectiveDuration = getEffectiveCycleDuration();
			const t = Math.max(0, audioCtx.currentTime - lastCycleStart);
			// Quantization par beat à 110 BPM (ajusté par la vitesse uniquement)
			const beatDur = (60 / BPM) / effectParams.playbackRate; // durée du beat ajustée
			const totalSteps = Math.max(1, Math.round(effectiveDuration / beatDur));
			const stepIndex = Math.min(totalSteps, Math.floor(t / beatDur));
			const frac = stepIndex / totalSteps;
			if (progressFill) progressFill.style.width = (frac * 100).toFixed(2) + '%';

			// Beat trigger: rotate playing pads by 90° each beat
			const beatIndex = Math.floor(t / beatDur);
			if (beatIndex !== __lastBeatIndex) {
				__lastBeatIndex = beatIndex;
				gridEl.querySelectorAll('.pad.playing').forEach(stepPadRotation);
			}
		}
	} finally {
		requestAnimationFrame(updateProgressVisual);
	}
}

// ----------------------------------------------
// 2D Side Visualizers for DRUM (left) and BASS (right)
// ----------------------------------------------
function init2DVisualizers() {
	if (!vizDrumCanvas || !vizBassCanvas) return;
	const dpr = Math.min(window.devicePixelRatio || 1, 2);
	function resize() {
		const W = 42; // css width in px (larger, stylized)
		const H = Math.max(200, window.innerHeight);
		// Drum canvas
		vizDrumCanvas.style.width = W + 'px';
		vizDrumCanvas.style.height = H + 'px';
		vizDrumCanvas.width = Math.floor(W * dpr);
		vizDrumCanvas.height = Math.floor(H * dpr);
		// Bass canvas
		vizBassCanvas.style.width = W + 'px';
		vizBassCanvas.style.height = H + 'px';
		vizBassCanvas.width = Math.floor(W * dpr);
		vizBassCanvas.height = Math.floor(H * dpr);
	}
	resize();
	window.addEventListener('resize', resize);

	const dctx = vizDrumCanvas.getContext('2d');
	const bctx = vizBassCanvas.getContext('2d');
	dctx.scale(dpr, dpr);
	bctx.scale(dpr, dpr);

	let drumSmooth = 0, bassSmooth = 0;
	function render2D() {
		// Ensure graph
		ensureGraph();
		// Pull frequency data
		const drumA = categoryNodes.drum?.analyser;
		const bassA = categoryNodes.bass?.analyser;
		const W = 42, H = parseInt(vizDrumCanvas.style.height || '0', 10) || window.innerHeight;

		if (drumA) {
			const arr = new Uint8Array(drumA.frequencyBinCount);
			drumA.getByteFrequencyData(arr);
			dctx.clearRect(0,0,W,H);
			drawSideSpectrum(dctx, arr, { side: 'left', W, H, color: getCssVar('--drum') });
		}

		if (bassA) {
			const arr = new Uint8Array(bassA.frequencyBinCount);
			bassA.getByteFrequencyData(arr);
			// emphasize lows: simple bin weighting
			for (let i=0;i<arr.length;i++) arr[i] = Math.min(255, arr[i] * (1 + (arr.length - i) / arr.length));
			bctx.clearRect(0,0,W,H);
			drawSideSpectrum(bctx, arr, { side: 'right', W, H, color: getCssVar('--bass') });
		}
		requestAnimationFrame(render2D);
	}
	render2D();
}

function getCssVar(name) {
	return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#fff';
}

// Start 2D visualizers
init2DVisualizers();

// Draw stylized side spectrum (polyline + soft fill) similar to provided reference
function drawSideSpectrum(ctx, freqArr, { side, W, H, color }) {
	// Parameters for style
	const maxX = W - 1; // allow full band utilization
	const bins = Math.min(128, freqArr.length); // more detail but kept smooth
	const stepY = H / (bins - 1);

	// Build smoothed values (simple 1D blur, sharper weighting)
	const values = new Array(bins);
	for (let i=0;i<bins;i++) {
		const idx = Math.floor((i / (bins - 1)) * (freqArr.length - 1));
		const a = freqArr[idx] / 255; // 0..1
		const b = freqArr[Math.max(0, idx-1)] / 255;
		const c = freqArr[Math.min(freqArr.length-1, idx+1)] / 255;
		values[i] = (a*0.75 + b*0.15 + c*0.10);
	}
	// Temporal smoothing (faster response for sharpness)
	if (!ctx.__prevVals || ctx.__prevVals.length !== bins) ctx.__prevVals = values.slice();
	for (let i=0;i<bins;i++) ctx.__prevVals[i] = ctx.__prevVals[i]*0.70 + values[i]*0.30;

	// Normalize spectrum per-frame to fill full band width
	let vmax = 0, vmean = 0;
	for (let i=0;i<bins;i++){ const v = ctx.__prevVals[i]; if (v>vmax) vmax=v; vmean += v; }
	vmean /= bins;
	const norm = vmax > 1e-4 ? (1 / vmax) : 1; // avoid div0
	// Also compute an overall amplitude metric (used for visual intensity, not width)
	const amp = Math.min(1, vmean / 0.25); // calibrate: 0.25 mean -> ~full intensity
	const gamma = 1.2; // higher gamma for more contrast/sharpness
	const xs = ctx.__prevVals.map(v => Math.pow(Math.min(1, v * norm), gamma) * maxX);

	// Background soft fill (use amp to modulate alpha)
	ctx.save();
	ctx.globalCompositeOperation = 'source-over';
	ctx.beginPath();
	if (side === 'left') ctx.moveTo(0, 0); else ctx.moveTo(W, 0);
	for (let i=0;i<bins;i++) {
		const y = i * stepY;
		const x = side === 'left' ? xs[i] : (W - xs[i]);
		ctx.lineTo(x, y);
	}
	if (side === 'left') ctx.lineTo(0, H); else ctx.lineTo(W, H);
	ctx.closePath();
	const fillGrad = side === 'left'
		? ctx.createLinearGradient(0,0,maxX,0)
		: ctx.createLinearGradient(W,0,W-maxX,0);
	const baseA = 0.42 + 0.38 * amp; // stronger fill with amplitude
	const tailA = 0.08 + 0.10 * amp;
	fillGrad.addColorStop(0, `rgba(10,20,40,${baseA.toFixed(3)})`);
	fillGrad.addColorStop(1, `rgba(10,20,40,${tailA.toFixed(3)})`);
	ctx.fillStyle = fillGrad;
	ctx.fill();

	// Outer glow stroke (stronger halo)
	ctx.save();
	ctx.globalAlpha = 0.8 * (0.6 + 0.4 * amp);
	ctx.shadowBlur = 24;
	ctx.shadowColor = color;
	ctx.lineWidth = 2.0;
	ctx.strokeStyle = color;
	ctx.beginPath();
	for (let i=0;i<bins;i++) {
		const y = i * stepY;
		const x = side === 'left' ? xs[i] : (W - xs[i]);
		if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
	}
	ctx.stroke();
	ctx.restore();

	// Main crisp neon stroke
	ctx.shadowBlur = 12; // lower blur for sharper edge
	ctx.shadowColor = color;
	ctx.lineWidth = 2.6;
	ctx.strokeStyle = color;
	ctx.beginPath();
	for (let i=0;i<bins;i++) {
		const y = i * stepY;
		const x = side === 'left' ? xs[i] : (W - xs[i]);
		if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
	}
	ctx.stroke();

	// Inner thin highlight
	ctx.shadowBlur = 0;
	ctx.lineWidth = 1.1;
	ctx.strokeStyle = 'rgba(255,255,255,0.75)';
	ctx.beginPath();
	for (let i=0;i<bins;i++) {
		const y = i * stepY;
		const x = side === 'left' ? Math.max(1, xs[i]-1) : Math.min(W-1, (W - xs[i])+1);
		if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
	}
	ctx.stroke();
	ctx.restore();
}

// ============================================
// PANNEAU DE CONTRÔLE - UI
// ============================================
const controlPanel = document.getElementById('controlPanel');
const togglePanelBtn = document.getElementById('togglePanel');
const closePanelBtn = document.getElementById('closePanel');

// Éléments de contrôle
const masterVolumeSlider = document.getElementById('masterVolume');
const reverbMixSlider = document.getElementById('reverbMix');
const delayMixSlider = document.getElementById('delayMix');
const delayTimeSlider = document.getElementById('delayTime');
const filterFreqSlider = document.getElementById('filterFreq');
const filterQSlider = document.getElementById('filterQ');
const pitchShiftSlider = document.getElementById('pitchShift');
const playbackRateSlider = document.getElementById('playbackRate');

// Affichages des valeurs
const masterVolumeVal = document.getElementById('masterVolumeVal');
const reverbMixVal = document.getElementById('reverbMixVal');
const delayMixVal = document.getElementById('delayMixVal');
const delayTimeVal = document.getElementById('delayTimeVal');
const filterFreqVal = document.getElementById('filterFreqVal');
const filterQVal = document.getElementById('filterQVal');
const pitchShiftVal = document.getElementById('pitchShiftVal');
const playbackRateVal = document.getElementById('playbackRateVal');

// Enregistrement
const recBtn = document.getElementById('recBtn');
const stopRecBtn = document.getElementById('stopRecBtn');
const downloadRecBtn = document.getElementById('downloadRecBtn');
const recStatus = document.getElementById('recStatus');
const recTime = document.getElementById('recTime');
const recControls = document.getElementById('recControls');

// Presets
const presetNameInput = document.getElementById('presetName');
const savePresetBtn = document.getElementById('savePreset');
const presetListEl = document.getElementById('presetList');

// Toggle panneau
if (togglePanelBtn) {
	togglePanelBtn.addEventListener('click', () => {
		controlPanel.classList.toggle('hidden');
	});
}
if (closePanelBtn) {
	closePanelBtn.addEventListener('click', () => {
		controlPanel.classList.add('hidden');
	});
}

// ============================================
// GESTION DES EFFETS
// ============================================
function updateEffectParam(param, value) {
	effectParams[param] = value;
	ensureCtx();
	
	switch(param) {
		case 'masterVolume':
			if (masterGain) masterGain.gain.setTargetAtTime(value, audioCtx.currentTime, 0.02);
			if (masterVolumeVal) masterVolumeVal.textContent = Math.round(value * 100) + '%';
			break;
		case 'reverbMix':
			if (reverbGain) reverbGain.gain.setTargetAtTime(value, audioCtx.currentTime, 0.02);
			if (dryGain) dryGain.gain.setTargetAtTime(1 - value * 0.5, audioCtx.currentTime, 0.02);
			if (reverbMixVal) reverbMixVal.textContent = Math.round(value * 100) + '%';
			break;
		case 'delayMix':
			if (delayGain) delayGain.gain.setTargetAtTime(value, audioCtx.currentTime, 0.02);
			if (delayMixVal) delayMixVal.textContent = Math.round(value * 100) + '%';
			break;
		case 'delayTime':
			if (delayNode) delayNode.delayTime.setTargetAtTime(value, audioCtx.currentTime, 0.02);
			if (delayTimeVal) delayTimeVal.textContent = Math.round(value * 1000) + 'ms';
			break;
		case 'filterFreq':
			if (filterNode) filterNode.frequency.setTargetAtTime(value, audioCtx.currentTime, 0.02);
			if (filterFreqVal) filterFreqVal.textContent = value >= 1000 ? (value/1000).toFixed(1) + 'kHz' : value + 'Hz';
			break;
		case 'filterQ':
			if (filterNode) filterNode.Q.setTargetAtTime(value, audioCtx.currentTime, 0.02);
			if (filterQVal) filterQVal.textContent = value.toFixed(1);
			break;
		case 'pitchShift':
			// Appliquer le pitch shift via le pitch shifter granulaire
			// On doit aussi compenser pour le playbackRate actuel
			applyCompensatedPitchShift();
			if (pitchShiftVal) pitchShiftVal.textContent = (value >= 0 ? '+' : '') + value;
			break;
		case 'playbackRate':
			// Appliqué en temps réel à toutes les sources actives
			for (const key of Object.keys(activeSources)) {
				if (activeSources[key]) {
					activeSources[key].playbackRate.setTargetAtTime(value, audioCtx.currentTime, 0.02);
				}
			}
			// Compenser le changement de pitch causé par le changement de vitesse
			applyCompensatedPitchShift();
			if (playbackRateVal) playbackRateVal.textContent = value.toFixed(2) + 'x';
			break;
	}
}

// Calcule et applique le pitch shift compensé pour la vitesse
function applyCompensatedPitchShift() {
	// Le playbackRate change le pitch naturellement
	// Pour compenser: si rate = 2, le pitch monte d'une octave (+12)
	// Donc on doit appliquer un pitch shift de -12 pour compenser
	// Formule: compensation = -12 * log2(playbackRate)
	
	const rate = effectParams.playbackRate;
	const userPitch = effectParams.pitchShift;
	
	// Compensation: combien de demi-tons le playbackRate ajoute naturellement
	// rate = 2 → +12 demi-tons, rate = 0.5 → -12 demi-tons
	const rateCompensation = -12 * Math.log2(rate);
	
	// Pitch total = pitch demandé par l'utilisateur + compensation de la vitesse
	const totalPitch = userPitch + rateCompensation;
	
	updatePitchShifter(totalPitch);
}

// Event listeners pour les sliders
if (masterVolumeSlider) masterVolumeSlider.addEventListener('input', e => updateEffectParam('masterVolume', parseFloat(e.target.value)));
if (reverbMixSlider) reverbMixSlider.addEventListener('input', e => updateEffectParam('reverbMix', parseFloat(e.target.value)));
if (delayMixSlider) delayMixSlider.addEventListener('input', e => updateEffectParam('delayMix', parseFloat(e.target.value)));
if (delayTimeSlider) delayTimeSlider.addEventListener('input', e => updateEffectParam('delayTime', parseFloat(e.target.value)));
if (filterFreqSlider) filterFreqSlider.addEventListener('input', e => updateEffectParam('filterFreq', parseFloat(e.target.value)));
if (filterQSlider) filterQSlider.addEventListener('input', e => updateEffectParam('filterQ', parseFloat(e.target.value)));
if (pitchShiftSlider) pitchShiftSlider.addEventListener('input', e => updateEffectParam('pitchShift', parseInt(e.target.value)));
if (playbackRateSlider) playbackRateSlider.addEventListener('input', e => updateEffectParam('playbackRate', parseFloat(e.target.value)));

// ============================================
// RESET DES EFFETS
// ============================================
const resetEffectsBtn = document.getElementById('resetEffects');

function resetAllEffects() {
	// Valeurs par défaut
	const defaults = {
		masterVolume: 1,
		reverbMix: 0,
		delayMix: 0,
		delayTime: 0.3,
		filterFreq: 20000,
		filterQ: 1,
		pitchShift: 0,
		playbackRate: 1
	};
	
	// Appliquer les valeurs par défaut
	for (const [param, value] of Object.entries(defaults)) {
		updateEffectParam(param, value);
	}
	
	// Mettre à jour les sliders
	if (masterVolumeSlider) masterVolumeSlider.value = defaults.masterVolume;
	if (reverbMixSlider) reverbMixSlider.value = defaults.reverbMix;
	if (delayMixSlider) delayMixSlider.value = defaults.delayMix;
	if (delayTimeSlider) delayTimeSlider.value = defaults.delayTime;
	if (filterFreqSlider) filterFreqSlider.value = defaults.filterFreq;
	if (filterQSlider) filterQSlider.value = defaults.filterQ;
	if (pitchShiftSlider) pitchShiftSlider.value = defaults.pitchShift;
	if (playbackRateSlider) playbackRateSlider.value = defaults.playbackRate;
}

if (resetEffectsBtn) resetEffectsBtn.addEventListener('click', resetAllEffects);

// ============================================
// ENREGISTREMENT AUDIO
// ============================================
function startRecording() {
	ensureCtx();
	if (!recordingDestination) return;
	
	recordedChunks = [];
	
	try {
		mediaRecorder = new MediaRecorder(recordingDestination.stream, {
			mimeType: 'audio/webm;codecs=opus'
		});
	} catch (e) {
		// Fallback si webm non supporté
		mediaRecorder = new MediaRecorder(recordingDestination.stream);
	}
	
	mediaRecorder.ondataavailable = (e) => {
		if (e.data.size > 0) {
			recordedChunks.push(e.data);
		}
	};
	
	mediaRecorder.onstop = () => {
		if (downloadRecBtn) downloadRecBtn.disabled = false;
		if (recStatus) recStatus.textContent = 'Prêt à télécharger';
	};
	
	mediaRecorder.start(100); // Chunk every 100ms
	recordingStartTime = Date.now();
	
	// Update UI
	if (recBtn) {
		recBtn.classList.add('recording');
		recBtn.textContent = '⏺️ En cours...';
		recBtn.disabled = true;
	}
	if (recControls) recControls.classList.remove('hidden');
	if (recStatus) recStatus.textContent = 'Enregistrement...';
	
	// Timer
	recordingTimer = setInterval(() => {
		const elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
		const mins = Math.floor(elapsed / 60).toString().padStart(2, '0');
		const secs = (elapsed % 60).toString().padStart(2, '0');
		if (recTime) recTime.textContent = `${mins}:${secs}`;
	}, 500);
}

function stopRecording() {
	if (mediaRecorder && mediaRecorder.state !== 'inactive') {
		mediaRecorder.stop();
	}
	
	if (recordingTimer) {
		clearInterval(recordingTimer);
		recordingTimer = null;
	}
	
	// Update UI
	if (recBtn) {
		recBtn.classList.remove('recording');
		recBtn.textContent = '⏺️ Enregistrer';
		recBtn.disabled = false;
	}
}

function downloadRecording() {
	if (recordedChunks.length === 0) return;
	
	const blob = new Blob(recordedChunks, { type: 'audio/webm' });
	
	// Convertir en WAV si possible, sinon télécharger en webm
	// Pour la simplicité, on télécharge en webm (conversion WAV complexe côté client)
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	const timestamp = new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-');
	a.download = `adventure-machine-${timestamp}.webm`;
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
	URL.revokeObjectURL(url);
	
	if (recStatus) recStatus.textContent = 'Téléchargé !';
}

// Event listeners enregistrement
if (recBtn) recBtn.addEventListener('click', startRecording);
if (stopRecBtn) stopRecBtn.addEventListener('click', stopRecording);
if (downloadRecBtn) downloadRecBtn.addEventListener('click', downloadRecording);

// ============================================
// GESTION DES PRESETS
// ============================================
function getPresets() {
	try {
		const data = localStorage.getItem(PRESETS_STORAGE_KEY);
		return data ? JSON.parse(data) : [];
	} catch {
		return [];
	}
}

function savePresets(presets) {
	localStorage.setItem(PRESETS_STORAGE_KEY, JSON.stringify(presets));
}

function getCurrentState() {
	// Capture l'état actuel (pads actifs + effets)
	const activePads = {};
	for (const cat of ['drum', 'bass', 'sound']) {
		activePads[cat] = playing[cat].map(o => o.key);
	}
	
	return {
		activePads,
		effects: { ...effectParams }
	};
}

function applyPreset(preset) {
	// Appliquer les effets
	if (preset.effects) {
		for (const [param, value] of Object.entries(preset.effects)) {
			updateEffectParam(param, value);
			// Mettre à jour les sliders
			const slider = document.getElementById(param);
			if (slider) slider.value = value;
		}
	}
	
	// Arrêter tout
	stopAll();
	
	// Réactiver les pads sauvegardés
	if (preset.activePads) {
		ensureCtx();
		const initial = [];
		for (const cat of ['drum', 'bass', 'sound']) {
			const keys = preset.activePads[cat] || [];
			for (const key of keys.slice(0, limits[cat])) {
				initial.push({ key, cat });
			}
		}
		if (initial.length > 0) {
			startNewCycle(initial);
		}
	}
}

function renderPresetList() {
	if (!presetListEl) return;
	
	const presets = getPresets();
	presetListEl.innerHTML = '';
	
	if (presets.length === 0) {
		presetListEl.innerHTML = '<p style="font-size:0.75rem;opacity:0.6;text-align:center;">Aucun preset sauvegardé</p>';
		return;
	}
	
	for (const preset of presets) {
		const item = document.createElement('div');
		item.className = 'preset-item';
		item.innerHTML = `
			<span class="preset-item-name">${preset.name}</span>
			<div class="preset-item-actions">
				<button class="preset-btn load-preset" data-name="${preset.name}">▶️</button>
				<button class="preset-btn delete delete-preset" data-name="${preset.name}">🗑️</button>
			</div>
		`;
		presetListEl.appendChild(item);
	}
	
	// Event listeners
	presetListEl.querySelectorAll('.load-preset').forEach(btn => {
		btn.addEventListener('click', () => {
			const name = btn.dataset.name;
			const presets = getPresets();
			const preset = presets.find(p => p.name === name);
			if (preset) applyPreset(preset);
		});
	});
	
	presetListEl.querySelectorAll('.delete-preset').forEach(btn => {
		btn.addEventListener('click', () => {
			const name = btn.dataset.name;
			const presets = getPresets().filter(p => p.name !== name);
			savePresets(presets);
			renderPresetList();
		});
	});
}

function saveCurrentPreset() {
	const name = presetNameInput?.value?.trim();
	if (!name) {
		alert('Veuillez entrer un nom pour le preset');
		return;
	}
	
	const state = getCurrentState();
	const preset = { name, ...state, savedAt: Date.now() };
	
	let presets = getPresets();
	// Remplacer si même nom existe
	presets = presets.filter(p => p.name !== name);
	presets.push(preset);
	savePresets(presets);
	
	if (presetNameInput) presetNameInput.value = '';
	renderPresetList();
}

if (savePresetBtn) savePresetBtn.addEventListener('click', saveCurrentPreset);

// Initialiser la liste des presets
renderPresetList();

// ============================================
// EXPOSER L'ÉTAT POUR DEBUG
// ============================================
window.__amState = { playing, pending, buffers, effectParams };


