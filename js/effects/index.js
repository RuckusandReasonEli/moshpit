// Effect registry. To add an effect, create a file shaped like the others and list it here.
import lumaMesh from './lumaMesh.js';
import opticalFlow from './opticalFlow.js';
import dataMosh from './dataMosh.js';
import feedback from './feedback.js';
import softGlitch from './softGlitch.js';
import hardGlitch from './hardGlitch.js';
import stretch from './stretch.js';
import eightBit from './eightBit.js';

export const EFFECTS = [lumaMesh, opticalFlow, dataMosh, feedback, softGlitch, hardGlitch, stretch, eightBit];
