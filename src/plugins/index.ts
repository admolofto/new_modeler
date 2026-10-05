// Registers the built-in plugins. Import this once before using the model or pipeline.
import './shapes/box';
import './shapes/outline';
import './features/hole';
import './features/pocket';
import './features/edgeProfile';
import './features/dado';
import './generators/carcass';
import './motions/hinge';
import './motions/slide';

export * from './registry';
