# Adventure Machine

Projet réalisé dans le cadre du cours **Traitement du Son et de la Musique Avancé** (M2 Info, parcours Image et Son, 2025).

Ce projet est un clone pédagogique de l'**Adventure Machine de Madeon** : une grille interactive de 36 pads (6×6) tournée à 45°, permettant de mixer des boucles audio en temps réel avec des effets audio avancés.

## 🎵 Fonctionnalités principales

### Grille de pads
- **36 pads** organisés en grille diamant (rotation 45°)
- **10 Drum** (bleu) — 1 seul à la fois
- **10 Bass** (rouge) — 1 seul à la fois
- **16 Sound** (bleu clair) — jusqu'à 3 en parallèle

### Comportement des pads
- Clic sur un pad → démarre son loop, rejoué à chaque cycle
- Si d'autres loops jouent → le nouveau pad est mis en **file d'attente** (queued) et démarre synchronisé au prochain cycle
- Si la limite de catégorie est atteinte → le plus ancien est remplacé **à la prochaine transition**
- Re-cliquer un pad actif → le désactive
- Bouton **Stop** → arrête tout immédiatement

### 🎚️ Effets Audio (panneau latéral)
- **Volume Master** : contrôle du volume global
- **Reverb** : réverbération par convolution (IR générée)
- **Delay** : écho avec feedback et temps réglable
- **Filtre Low-pass** : filtre passe-bas avec résonance (Q)
- **Pitch Shift** : transposition de -12 à +12 demi-tons **sans changer la vitesse**
- **Playback Rate** : modification de la vitesse **sans changer le pitch**
- **Bouton Reset** : réinitialise tous les effets à leurs valeurs par défaut

### 🎙️ Enregistrement
- Enregistrement de la session en temps réel
- Export au format WebM
- Timer d'enregistrement visible

### 💾 Presets
- Sauvegarde de l'état actuel (pads actifs + paramètres d'effets)
- Chargement et suppression de presets
- Persistance dans le localStorage du navigateur

### 🎨 Visualisation
- **Visualiseur 3D** (Three.js) : 3 anneaux spectraux pour les sons actifs
- **Visualiseurs 2D latéraux** : waveforms stylisées pour Drum (gauche) et Bass (droite)
- **Barre de progression** : indique la position dans le cycle actuel
- **Effets néon** : pulsation des pads actifs synchronisée au BPM

## 🚀 Installation et utilisation

1. **Lancer un serveur local** :
   ```bash
   python -m http.server 8080
   ```
   
2. **Ouvrir dans le navigateur** : http://localhost:8080

3. **Samples audio** : Les fichiers `.wav` sont déjà présents dans le dossier `Madeon Adventure Machine Samples v2/`. Les pads dont le fichier manque sont grisés.

4. **Utilisation** :
   - Cliquer sur les pads pour démarrer les loops
   - Ouvrir le panneau **⚙️ Effets** pour accéder aux contrôles
   - Utiliser les sliders pour modifier les effets en temps réel
   - Enregistrer et exporter votre session

## 🔧 Architecture technique

### Technologies utilisées
- **Web Audio API** : lecture, synchronisation, effets (reverb, delay, filtre, pitch shifting)
- **Three.js** : visualisation 3D avec anneaux spectraux
- **Canvas 2D** : visualiseurs latéraux
- **CSS Grid + Transform** : grille diamant responsive
- **LocalStorage** : persistance des presets

### Chaîne audio
```
Sources → Analyseurs → Gains catégorie → Pitch Shifter → Filtre → Reverb/Delay → Master → Sortie
                                                                                      ↓
                                                                              Enregistrement
```

### Pitch Shifter
Implémentation d'un pitch shifter **granulaire** utilisant deux delay lines modulées :
- Permet de changer le pitch sans affecter la durée
- Compensation automatique pour le playback rate

## 📁 Structure des fichiers

```
├── index.html          # Structure HTML + panneau de contrôle
├── style.css           # Styles (thème néon, grille diamant, panneau)
├── app.js              # Logique audio, effets, visualisation, presets
├── README.md           # Ce fichier
└── Madeon Adventure Machine Samples v2/
    ├── drum.1.1.wav ... drum.1.10.wav
    ├── bass.1.1.wav ... bass.1.10.wav
    └── sounds.1.1.wav ... sounds.1.16.wav
```

## 🎯 Concepts du cours appliqués

- **Traitement du signal audio** : filtrage, convolution (reverb), modulation de délai
- **Synthèse granulaire** : pitch shifting sans modification de durée
- **Synchronisation audio** : scheduler lookahead pour une synchro précise
- **Analyse spectrale** : FFT pour les visualisations en temps réel
- **Utilisation d'IA générative** : développement assisté par Copilot/ChatGPT

## 📝 Licence

Projet pédagogique libre d'utilisation.

