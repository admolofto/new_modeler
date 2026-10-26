// Registers the built-in plugins. Import this once before using the model or pipeline.
import './shapes/box';
import './shapes/outline';
import './shapes/decor/hardware';
import './shapes/decor/room';
import './shapes/decor/lighting';
import './shapes/decor/appliance';
import './shapes/decor/furniture';
import './shapes/decor/accessory';
import './features/hole';
import './features/pocket';
import './features/edgeProfile';
import './features/dado';
import './generators/carcass';
import './generators/room';
import './generators/wall';
import './generators/appliances';
import './motions/hinge';
import './motions/slide';

export * from './registry';
