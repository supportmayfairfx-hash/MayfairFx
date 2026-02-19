import { Canvas, useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { Html, RoundedBox } from "@react-three/drei";
import { Bloom, EffectComposer, Vignette } from "@react-three/postprocessing";

type Tone = "cool" | "profit" | "risk";
type PlateTone = "pos" | "neg" | "muted";

export type MarketCorePlate = {
  id: string;
  label: string;
  value: string;
  chg: string;
  tone: PlateTone;
};

function webglOk(): boolean {
  try {
    if (typeof document === "undefined") return false;
    const c = document.createElement("canvas");
    const gl = (c.getContext("webgl") || c.getContext("experimental-webgl")) as any;
    return !!gl;
  } catch {
    return false;
  }
}

function palette(tone: Tone) {
  if (tone === "profit") return { a: new THREE.Color("#34d399"), b: new THREE.Color("#60a5fa"), c: new THREE.Color("#e7eefc") };
  if (tone === "risk") return { a: new THREE.Color("#ff5f7a"), b: new THREE.Color("#f59e0b"), c: new THREE.Color("#e7eefc") };
  return { a: new THREE.Color("#60a5fa"), b: new THREE.Color("#34d399"), c: new THREE.Color("#e7eefc") };
}

function glowTex(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 256;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.35, "rgba(255,255,255,0.35)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c);
  t.needsUpdate = true;
  return t;
}

function Scene({
  tone,
  plates,
  pointer
}: {
  tone: Tone;
  plates: MarketCorePlate[];
  pointer: { x: number; y: number };
}) {
  const grp = useRef<THREE.Group | null>(null);
  const ring = useRef<THREE.Mesh | null>(null);
  const orb = useRef<THREE.Mesh | null>(null);
  const grid = useRef<THREE.GridHelper | null>(null);
  const platesGrp = useRef<THREE.Group | null>(null);
  const pals = useMemo(() => palette(tone), [tone]);
  const spriteTex = useMemo(() => (typeof document !== "undefined" ? glowTex() : new THREE.Texture()), []);

  const particles = useMemo(() => {
    const n = 900;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const r = 1.2 + Math.random() * 2.2;
      const a = Math.random() * Math.PI * 2;
      const y = (Math.random() - 0.5) * 1.4;
      pos[i * 3 + 0] = Math.cos(a) * r + (Math.random() - 0.5) * 0.08;
      pos[i * 3 + 1] = y;
      pos[i * 3 + 2] = Math.sin(a) * r + (Math.random() - 0.5) * 0.08;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    return g;
  }, []);

  useFrame(({ clock, camera }) => {
    const t = clock.getElapsedTime();
    const px = pointer.x;
    const py = pointer.y;

    // Camera rig: gentle parallax.
    camera.position.x = THREE.MathUtils.lerp(camera.position.x, px * 0.65, 0.06);
    camera.position.y = THREE.MathUtils.lerp(camera.position.y, -py * 0.35, 0.06);
    camera.lookAt(0, 0, 0);

    if (grp.current) {
      grp.current.rotation.y = THREE.MathUtils.lerp(grp.current.rotation.y, px * 0.22, 0.08) + Math.sin(t * 0.4) * 0.01;
      grp.current.rotation.x = THREE.MathUtils.lerp(grp.current.rotation.x, -py * 0.14, 0.08) + Math.cos(t * 0.35) * 0.01;
    }
    if (ring.current) ring.current.rotation.z = t * 0.22;
    if (orb.current) {
      orb.current.position.y = -0.12 + Math.sin(t * 0.9) * 0.04;
      orb.current.rotation.y = t * 0.24;
      const m = orb.current.material as THREE.MeshPhysicalMaterial;
      m.emissiveIntensity = 0.55 + Math.sin(t * 1.1) * 0.08;
    }
    if (platesGrp.current) {
      platesGrp.current.rotation.y = THREE.MathUtils.lerp(platesGrp.current.rotation.y, px * 0.16, 0.06);
      platesGrp.current.rotation.x = THREE.MathUtils.lerp(platesGrp.current.rotation.x, -py * 0.08, 0.06);
      platesGrp.current.position.y = Math.sin(t * 0.8) * 0.015;
    }
    if (grid.current) {
      const m0 = grid.current.material as any;
      const mats: THREE.LineBasicMaterial[] = Array.isArray(m0) ? m0 : [m0];
      for (const m of mats) {
        if (!m) continue;
        m.transparent = true;
        m.opacity = 0.12 + Math.sin(t * 0.6) * 0.02;
      }
    }
  });

  return (
    <group ref={grp}>
      <fog attach="fog" args={["#0b1220", 3.4, 8.6]} />
      <ambientLight intensity={0.85} />
      <directionalLight position={[2.4, 2.2, 1.2]} intensity={1.15} color={pals.c} />
      <pointLight position={[-2.0, 0.6, -1.4]} intensity={0.9} color={pals.b} distance={8} />
      <pointLight position={[2.2, -0.3, 1.8]} intensity={0.75} color={pals.a} distance={8} />
      <pointLight position={[0.0, 0.2, 2.2]} intensity={0.9} color={pals.a} distance={7} />

      {/* Soft back plate */}
      <mesh position={[0, 0, -2.0]}>
        <planeGeometry args={[8, 5]} />
        <meshBasicMaterial color={new THREE.Color("#0b1220")} transparent opacity={0.14} />
      </mesh>

      {/* Terminal grid floor */}
      <gridHelper
        ref={grid as any}
        args={[8, 26, pals.b, pals.a]}
        position={[0, -0.85, 0.0]}
        rotation={[0, 0, 0]}
      />

      {/* Glass slabs (feels like "floating cards" without needing 3D text deps) */}
      <mesh position={[-0.7, 0.45, 0.0]} rotation={[0.08, -0.26, 0.02]}>
        <boxGeometry args={[1.7, 1.05, 0.06]} />
        <meshPhysicalMaterial
          color={new THREE.Color("#e7eefc")}
          transparent
          opacity={0.12}
          roughness={0.14}
          metalness={0.05}
          clearcoat={0.7}
          clearcoatRoughness={0.18}
          transmission={0.55}
          thickness={0.5}
        />
      </mesh>
      <mesh position={[0.95, 0.0, 0.05]} rotation={[0.02, 0.2, -0.02]}>
        <boxGeometry args={[1.9, 1.15, 0.06]} />
        <meshPhysicalMaterial
          color={new THREE.Color("#e7eefc")}
          transparent
          opacity={0.10}
          roughness={0.18}
          metalness={0.05}
          clearcoat={0.7}
          clearcoatRoughness={0.22}
          transmission={0.58}
          thickness={0.55}
        />
      </mesh>

      {/* Central glow orb (reads as "3D core") */}
      <mesh ref={orb} position={[0.1, -0.12, 0.5]}>
        <sphereGeometry args={[0.46, 48, 48]} />
        <meshPhysicalMaterial
          color={pals.c}
          roughness={0.12}
          metalness={0.08}
          transmission={0.85}
          thickness={1.1}
          clearcoat={1.0}
          clearcoatRoughness={0.12}
          ior={1.35}
          emissive={pals.a}
          emissiveIntensity={0.62}
        />
      </mesh>
      {/* Cheap "bloom" without postprocessing: layered additive sprites */}
      <sprite position={[0.1, -0.12, 0.55]} scale={[2.2, 2.2, 1]}>
        <spriteMaterial map={spriteTex} color={pals.a} transparent opacity={0.14} depthWrite={false} blending={THREE.AdditiveBlending} />
      </sprite>
      <sprite position={[0.2, -0.05, 0.35]} scale={[1.2, 1.2, 1]}>
        <spriteMaterial map={spriteTex} color={pals.b} transparent opacity={0.10} depthWrite={false} blending={THREE.AdditiveBlending} />
      </sprite>

      {/* Neon ring */}
      <mesh ref={ring} position={[0.6, -0.35, 0.2]} rotation={[Math.PI / 2.2, 0.0, 0.0]}>
        <torusGeometry args={[0.78, 0.02, 12, 120]} />
        <meshStandardMaterial emissive={pals.a} emissiveIntensity={1.1} color={pals.a} transparent opacity={0.45} />
      </mesh>
      <sprite position={[0.6, -0.35, 0.25]} scale={[2.0, 2.0, 1]}>
        <spriteMaterial map={spriteTex} color={pals.a} transparent opacity={0.10} depthWrite={false} blending={THREE.AdditiveBlending} />
      </sprite>

      {/* Particle halo */}
      <points geometry={particles}>
        <pointsMaterial size={0.018} color={pals.b} transparent opacity={0.38} depthWrite={false} />
      </points>

      {/* Floating metric plates (TradingView-ish glass labels in 3D space) */}
      <group ref={platesGrp}>
        {plates.map((p, i) => {
          const pos: [number, number, number] =
            i === 0 ? ([-1.35, 0.85, 0.35] as any) :
            i === 1 ? ([1.25, 0.75, 0.25] as any) :
            i === 2 ? ([-1.45, -0.10, 0.28] as any) :
            ([1.30, -0.30, 0.40] as any);
          const rot: [number, number, number] =
            i === 0 ? ([0.08, 0.22, 0.02] as any) :
            i === 1 ? ([0.06, -0.22, -0.02] as any) :
            i === 2 ? ([0.02, 0.26, 0.0] as any) :
            ([0.02, -0.26, 0.0] as any);

          return (
            <group key={p.id} position={pos} rotation={rot}>
              <RoundedBox args={[1.45, 0.72, 0.07]} radius={0.12} smoothness={8}>
                <meshPhysicalMaterial
                  color={pals.c}
                  transparent
                  opacity={0.10}
                  roughness={0.16}
                  metalness={0.06}
                  clearcoat={0.75}
                  clearcoatRoughness={0.18}
                  transmission={0.6}
                  thickness={0.6}
                />
              </RoundedBox>
              <Html transform distanceFactor={7.5} position={[0, 0, 0.06]} style={{ pointerEvents: "none" }}>
                <div className={`mcPlate ${p.tone}`}>
                  <div className="mcPlateTop">
                    <div className="mcPlateLbl mono">{p.label}</div>
                    <div className={`mcPlateChg mono ${p.tone}`}>{p.chg}</div>
                  </div>
                  <div className="mcPlateVal mono">{p.value}</div>
                </div>
              </Html>
            </group>
          );
        })}
      </group>
    </group>
  );
}

export default function MarketCore3D({
  tone,
  className,
  plates = []
}: {
  tone: Tone;
  className?: string;
  plates?: MarketCorePlate[];
}) {
  const [ok, setOk] = useState(false);
  const pointer = useRef({ x: 0, y: 0 });

  useEffect(() => setOk(webglOk()), []);

  if (!ok) return null;

  const bloom = tone === "risk" ? 0.85 : tone === "profit" ? 1.05 : 0.95;

  return (
    <div
      className={className}
      onMouseMove={(e) => {
        const r = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
        const nx = (e.clientX - r.left) / Math.max(1, r.width);
        const ny = (e.clientY - r.top) / Math.max(1, r.height);
        pointer.current.x = (nx - 0.5) * 2;
        pointer.current.y = (ny - 0.5) * 2;
      }}
      onMouseLeave={() => {
        pointer.current.x = 0;
        pointer.current.y = 0;
      }}
      aria-hidden="true"
    >
      <Canvas
        gl={{ alpha: true, antialias: true, powerPreference: "high-performance" }}
        dpr={[1, 2]}
        camera={{ position: [0.0, 0.2, 4.0], fov: 38 }}
        style={{ width: "100%", height: "100%", display: "block" }}
        onCreated={({ gl }) => {
          gl.toneMapping = THREE.ACESFilmicToneMapping;
          gl.toneMappingExposure = 1.05;
        }}
      >
        <color attach="background" args={["#000000"]} />
        <Scene tone={tone} plates={plates} pointer={pointer.current} />
        <EffectComposer multisampling={0}>
          <Bloom intensity={bloom} luminanceThreshold={0.12} luminanceSmoothing={0.9} mipmapBlur />
          <Vignette eskil={false} offset={0.22} darkness={0.62} />
        </EffectComposer>
      </Canvas>
    </div>
  );
}
