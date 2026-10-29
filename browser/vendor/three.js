// window.THREE for html artifacts: three.js plus OrbitControls (THREE.OrbitControls).
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
window.THREE = { ...THREE, OrbitControls };
