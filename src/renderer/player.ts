import { useLocalStorage } from "@vueuse/core";
import type { IAudioMetadata } from "music-metadata";
import { reactive, watch } from "vue";
import { analyze } from "web-audio-beat-detector";
import { useElectron } from "./amethyst";
import type ElectronEventManager from "./electronEventManager";
import type AppState from "./state";
import { BPM_COMPUTATION_CONCURRENCY, COVERART_RENDERING_CONCURRENCY } from "./state";

export const ALLOWED_EXTENSIONS = ["ogg", "flac", "wav", "opus", "aac", "aiff", "mp3", "m4a"];

async function analyzeBpm(path: string) {
	// get an AudioBuffer from the file
	const uint: Uint8Array = await useElectron().invoke("read-file", [path]);
	const audioContext = new AudioContext();
	const audioBuffer = await audioContext.decodeAudioData(uint.buffer);

	// analyze the audio buffer
	const bpm = Math.round (await analyze(audioBuffer));

	return bpm;
}

// Turns seconds from 80 to 1:20
export const secondsHuman = (time: number) => {
	const seconds = ~~time;
	const minutes = ~~(seconds / 60);
	const secondsLeft = seconds % 60;
	return `${minutes || 0}:${secondsLeft < 10 ? "0" : ""}${secondsLeft || 0}`;
};

export default class Player {
	public state = reactive({
		sound: new Audio(),
		richPresenceTimer: null as null | NodeJS.Timer,
		ctx: new window.AudioContext(),
		source: null as null | MediaElementAudioSourceNode,
		currentlyPlayingMetadata: null as null | IAudioMetadata,
		currentlyPlayingFilePath: useLocalStorage<string>("currentlyPlayingFilePath", ""),
		queue: useLocalStorage<string[]>("queue", []),
		currentlyPlayingIndex: -1,
		volume: useLocalStorage<number>("volume", 1),
		isPlaying: false,
	});

	constructor(public appState: AppState, public electron: ElectronEventManager) {
    this.electron.electron.on<string>("play-file", (file) => {
      if (file === "--require")
      return;
      this.addToQueueAndPlay(file);
    });
    this.electron.electron.on<(string)[]>("play-folder", files => this.setQueue(files));
    this.electron.electron.on<(string)[]>("load-folder", files => this.setQueue([...files, ...this.getQueue()]));

		// When the queue changes updated the current playing file path
		watch(() => this.state.queue.length, () => {
			this.updateCurrentlyPlayingFilePath();
			this.analyzeQueueForBpm();
		});

		// When the playing index changes update the current playing file path
		watch(() => this.state.currentlyPlayingIndex, () => {
			this.updateCurrentlyPlayingFilePath();
		});

		// When the currently playing file path changes play the new file
		watch(() => this.state.currentlyPlayingFilePath, () => {
			this.loadSoundAndPlay(this.state.currentlyPlayingFilePath);
		});

		// this.analyzeQueueForBpm();
	}

	public getCoverArt = async (path: string) => {
		if (this.appState.state.coverProcessQueue < COVERART_RENDERING_CONCURRENCY) {
			this.appState.state.coverProcessQueue++;
			try {
				this.appState.state.coverCache[path] = await this.electron.invoke<string>("get-cover", [path]);
			}
			catch (error) { }
			this.appState.state.coverProcessQueue--;
		}
		else {
			setTimeout(async () =>
				this.getCoverArt(path), 100,
			);
		}
	};

	public getBpm = async (path: string) => {
		if (this.appState.state.bpmProcessQueue < BPM_COMPUTATION_CONCURRENCY) {
			this.appState.state.bpmProcessQueue++;
			try {
				this.appState.state.bpmCache[path] = await analyzeBpm(path);
			}
			catch (error) { }
			this.appState.state.bpmProcessQueue--;
		}
		else {
			setTimeout(async () =>
				this.getBpm(path), 100,
			);
		}
	};

	public analyzeQueueForBpm() {
		for (let i = 0; i < this.getQueue().length; i++) {
			const path = this.getQueue()[i];
			if (path && !this.appState.state.bpmCache[path])
				this.getBpm(path);
		}
	}

	loadSoundAndPlay(path: string) {
		this.state.sound && this.pause();
		this.state.sound = new Audio(path);
		this.state.sound.volume = this.state.volume;
		this.play();
		this.state.sound.onended = () => {
			this.next();
		};

		// Pixelated covers
		// invoke<Buffer>("get-cover-pixelized", [path]).then((cover) => {
		//   currentCover.value = `data:image/png;base64,${cover}`;
		// });

		// This is the timer for the current duration ont he UI
		// because for some reason it doesnt wanna update on its own

		// Discord rich presence timer that updates discord every second
		this.state.richPresenceTimer && clearInterval(this.state.richPresenceTimer);
		this.state.richPresenceTimer = setInterval(() => {
			this.state.currentlyPlayingMetadata && this.electron.invoke("update-rich-presence", [
				this.state.currentlyPlayingMetadata.common.artist ? `${this.state.currentlyPlayingMetadata.common.artist || "Unkown Artist"} - ${this.state.currentlyPlayingMetadata.common.title}` : this.state.currentlyPlayingFilePath.substring(this.state.currentlyPlayingFilePath.lastIndexOf("\\") + 1),
				secondsHuman(this.state.currentlyPlayingMetadata.format.duration!),
				secondsHuman(this.getCurrentTime()),
				this.state.isPlaying.toString(),
			]);
		}, 1000);

		// set the html title to the song name
		document.title = path || "Amethyst";

		this.electron.invoke<IAudioMetadata>("get-metadata", [path]).then(
			(data) => {
				this.state.currentlyPlayingMetadata = data;
			});

		this.state.source = this.state.ctx.createMediaElementSource(this.state.sound);
		this.state.source.connect(this.state.ctx.destination);
	}

	public static fisherYatesShuffle<T>(array: T[]) {
		let m = array.length; let t; let i;
		while (m) {
			i = ~~(Math.random() * m--);

			t = array[m];
			array[m] = array[i];
			array[i] = t;
		}
		return array;
	}

	public spreadArray(array: string[]): string[] {
		return array.reduce((acc, item) => {
			if (Array.isArray(item))
				return acc.concat(this.spreadArray(item));
			else
				return acc.concat(item);
		}, [] as string[]);
	}

	public play() {
		this.state.sound.play();
		this.state.isPlaying = true;
	}

	public pause() {
		this.state.sound.pause();
		this.state.isPlaying = false;
	}

	public next(skip = 1) {
		if ((this.state.currentlyPlayingIndex + skip) < (this.state.queue.length - skip))
		this.state.currentlyPlayingIndex++;
	}

	public previous(skip = 1) {
		if ((this.state.currentlyPlayingIndex - skip) > 0)
		this.state.currentlyPlayingIndex--;
	}

	public setVolume(volume: number) {
		this.state.sound.volume = volume;
		this.state.volume = volume;
	}

	public volumeUp(amount = 0.1) {
		this.setVolume(this.state.sound.volume = Math.min(1, this.state.sound.volume + amount));
	}

	public volumeDown(amount = 0.1) {
		this.setVolume(Math.max(0, this.state.sound.volume - amount));
	}

	public addToQueueAndPlay(file: string) {
		if (ALLOWED_EXTENSIONS.includes(file.substring(file.lastIndexOf(".") + 1).toLowerCase())) {
			this.state.queue.unshift(file);
			this.state.currentlyPlayingIndex = 0;
		}
	}

	public getQueue() {
		return this.state.queue;
	}

	public setQueue(files: string[]) {
		this.state.queue = this.spreadArray(files);
	}

	public clearQueue() {
		this.state.queue = [];
	}

	public getCurrentTime() {
		return this.state.sound.currentTime;
	}

	public seekForward(step = 5) {
		this.state.sound.currentTime += step;
	}

	public seekBackward(step = 5) {
		this.state.sound.currentTime -= step;
	}

	public isPlaying() {
		return this.state.isPlaying;
	}

	public shuffle() {
		this.state.queue = Player.fisherYatesShuffle(this.state.queue);
	}

	public getCurrentlyPlayingIndex() {
		return this.state.currentlyPlayingIndex;
	}

	public setCurrentlyPlayingIndex(index: number) {
		this.state.currentlyPlayingIndex = index;
	}

	public getCurrentlyPlayingFilePath() {
		return this.state.queue[this.state.currentlyPlayingIndex];
	}

	public updateCurrentlyPlayingFilePath() {
		this.state.currentlyPlayingFilePath = this.getCurrentlyPlayingFilePath();
	}

	public currentTimeFormatted() {
		return secondsHuman(this.state.sound.currentTime);
	}

	public currentDurationFormatted() {
		return secondsHuman(this.state.sound.duration);
	}
}
