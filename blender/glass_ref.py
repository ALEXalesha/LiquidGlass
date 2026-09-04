"""
Physical reference for the Liquid Glass demo.

Builds the same geometry the web version fakes - a squircle plan form with a
quarter round rim - gives it real glass with a real index of refraction, and
renders it in Cycles. The point is to have something honest to compare the
CSS and WebGL builds against.

    blender -b -P blender/glass_ref.py

Writes blender/out/glass_ref.png
"""

import bpy
import bmesh
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(bpy.data.filepath or __file__))
if "--" in sys.argv:
    HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")

# panel, capsule and rim proportions, in blender units
IOR = 1.52
DISPERSION = 0.35
RIM_ROUGHNESS = 0.03


def wipe():
    for coll in (bpy.data.objects, bpy.data.meshes, bpy.data.materials,
                 bpy.data.lights, bpy.data.cameras, bpy.data.curves):
        for item in list(coll):
            coll.remove(item)


def squircle_outline(a, b, r, n, corner_pts=44, edge_pts=10):
    """Rounded rectangle whose corners follow x^n + y^n = r^n, walked counter
    clockwise from the right end of the top right corner.

    n = 2 is an ordinary circular corner, n = 4 is the continuous corner Apple
    uses and the one the shader draws."""
    cx, cy = a - r, b - r

    def arc(sx, sy, up):
        """One quadrant. phi = 0 is the horizontal extreme, phi = pi/2 the
        vertical one; up walks from horizontal to vertical."""
        pts = []
        for i in range(corner_pts + 1):
            phi = (i / corner_pts) * (math.pi / 2)
            if not up:
                phi = math.pi / 2 - phi
            x = cx + r * math.cos(phi) ** (2.0 / n)
            y = cy + r * math.sin(phi) ** (2.0 / n)
            pts.append((sx * x, sy * y))
        return pts

    def span(p0, p1):
        return [(p0[0] + (p1[0] - p0[0]) * i / edge_pts,
                 p0[1] + (p1[1] - p0[1]) * i / edge_pts)
                for i in range(1, edge_pts)]

    quads = [
        arc(1, 1, True),     # right -> top
        arc(-1, 1, False),   # top -> left
        arc(-1, -1, True),   # left -> bottom
        arc(1, -1, False),   # bottom -> right
    ]

    pts = []
    for k, q in enumerate(quads):
        pts += q
        pts += span(q[-1], quads[(k + 1) % 4][0])
    return pts


def slab(name, a, b, r, n, rim, rim_h, wall, rings=16):
    """Squircle slab with an elliptical rim top and bottom.

    rim is how far the bevel reaches inward, rim_h how far it rises. Keeping
    them equal gives a true quarter round, and that is wrong for a ui panel:
    the surface ends up vertical at the outline, rays leave along the backdrop
    and the edge goes black. Apple's bevel is wide and shallow."""
    m = len(squircle_outline(a, b, r, n))

    verts = []
    rows = []

    def ring(inset, z):
        # insetting a rounded rect is just a smaller rounded rect, which
        # cannot self intersect the way offsetting by normals can
        ring_pts = squircle_outline(a - inset, b - inset,
                                    max(r - inset, 1e-3), n)
        rows.append(len(verts))
        for px, py in ring_pts:
            verts.append((px, py, z))

    half = wall * 0.5

    # top rim: theta 90 -> 0, from the flat top down to the outline
    for i in range(rings + 1):
        th = (math.pi / 2) * (1.0 - i / rings)
        ring(rim * (1.0 - math.cos(th)), half + rim_h * math.sin(th))
    # straight wall
    ring(0.0, -half)
    # bottom rim, mirrored
    for i in range(1, rings + 1):
        th = (math.pi / 2) * (i / rings)
        ring(rim * (1.0 - math.cos(th)), -half - rim_h * math.sin(th))

    faces = []
    for k in range(len(rows) - 1):
        r0, r1 = rows[k], rows[k + 1]
        for i in range(m):
            j = (i + 1) % m
            faces.append((r0 + i, r0 + j, r1 + j, r1 + i))

    top = list(range(rows[0], rows[0] + m))
    bot = list(range(rows[-1], rows[-1] + m))
    faces.append(tuple(top))
    faces.append(tuple(reversed(bot)))

    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.validate()

    # flat caps, smooth rim: the junction stays crisp the way a real edge is
    for poly in mesh.polygons:
        poly.use_smooth = abs(poly.normal.z) < 0.98
    mesh.update()

    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def glass_material():
    """Blender 5.2 dropped the Dispersion input on Principled, so split the
    glass into three per channel lobes with their own index of refraction.
    Same idea as the WebGL build, three wavelengths instead of fourteen."""
    mat = bpy.data.materials.new("LiquidGlass")
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()

    out = nt.nodes.new("ShaderNodeOutputMaterial")
    spread = IOR * DISPERSION * 0.5
    lobes = []
    for name, tint, ior in (
        ("R", (1, 0, 0, 1), IOR + spread),
        ("G", (0, 1, 0, 1), IOR),
        ("B", (0, 0, 1, 1), IOR - spread),
    ):
        g = nt.nodes.new("ShaderNodeBsdfGlass")
        g.label = name
        g.inputs["Color"].default_value = tint
        g.inputs["Roughness"].default_value = RIM_ROUGHNESS
        g.inputs["IOR"].default_value = ior
        lobes.append(g)

    add1 = nt.nodes.new("ShaderNodeAddShader")
    add2 = nt.nodes.new("ShaderNodeAddShader")
    nt.links.new(lobes[0].outputs[0], add1.inputs[0])
    nt.links.new(lobes[1].outputs[0], add1.inputs[1])
    nt.links.new(add1.outputs[0], add2.inputs[0])
    nt.links.new(lobes[2].outputs[0], add2.inputs[1])
    nt.links.new(add2.outputs[0], out.inputs["Surface"])
    return mat


def backdrop_material():
    """Colourful, high contrast, with a crisp grid. Without hard edges behind
    it there is nothing for the refraction to bend."""
    mat = bpy.data.materials.new("Backdrop")
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()

    out = nt.nodes.new("ShaderNodeOutputMaterial")
    emit = nt.nodes.new("ShaderNodeEmission")
    emit.inputs["Strength"].default_value = 1.0

    coord = nt.nodes.new("ShaderNodeTexCoord")

    # four colour pools across the plane
    grad = nt.nodes.new("ShaderNodeTexGradient")
    grad.gradient_type = "LINEAR"
    map_g = nt.nodes.new("ShaderNodeMapping")
    map_g.inputs["Rotation"].default_value[2] = math.radians(35)

    ramp = nt.nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.interpolation = "EASE"
    stops = [
        (0.00, (1.00, 0.28, 0.10, 1)),
        (0.28, (1.00, 0.72, 0.10, 1)),
        (0.52, (0.10, 0.75, 0.45, 1)),
        (0.74, (0.12, 0.28, 1.00, 1)),
        (1.00, (0.72, 0.15, 1.00, 1)),
    ]
    while len(ramp.color_ramp.elements) > 1:
        ramp.color_ramp.elements.remove(ramp.color_ramp.elements[-1])
    ramp.color_ramp.elements[0].position = stops[0][0]
    ramp.color_ramp.elements[0].color = stops[0][1]
    for pos, col in stops[1:]:
        el = ramp.color_ramp.elements.new(pos)
        el.color = col

    # a grid of thin lines, not a checkerboard: hard edges are what makes
    # the lensing readable
    def bands(axis):
        w = nt.nodes.new("ShaderNodeTexWave")
        w.wave_type = "BANDS"
        w.bands_direction = axis
        w.wave_profile = "SAW"
        w.inputs["Scale"].default_value = 9.0
        w.inputs["Distortion"].default_value = 0.0
        cr = nt.nodes.new("ShaderNodeValToRGB")
        cr.color_ramp.interpolation = "CONSTANT"
        cr.color_ramp.elements[0].position = 0.0
        cr.color_ramp.elements[0].color = (1, 1, 1, 1)
        cr.color_ramp.elements[1].position = 0.06
        cr.color_ramp.elements[1].color = (0, 0, 0, 1)
        nt.links.new(coord.outputs["Object"], w.inputs["Vector"])
        nt.links.new(w.outputs["Fac"], cr.inputs["Fac"])
        return cr

    grid = nt.nodes.new("ShaderNodeMix")
    grid.data_type = "RGBA"
    grid.blend_type = "ADD"
    grid.inputs["Factor"].default_value = 1.0
    nt.links.new(bands("X").outputs["Color"], grid.inputs[6])
    nt.links.new(bands("Y").outputs["Color"], grid.inputs[7])

    mix = nt.nodes.new("ShaderNodeMix")
    mix.data_type = "RGBA"
    mix.blend_type = "SCREEN"
    mix.inputs["Factor"].default_value = 0.30

    nt.links.new(coord.outputs["Object"], map_g.inputs["Vector"])
    nt.links.new(map_g.outputs["Vector"], grad.inputs["Vector"])
    nt.links.new(grad.outputs["Fac"], ramp.inputs["Fac"])
    nt.links.new(ramp.outputs["Color"], mix.inputs[6])      # A
    nt.links.new(grid.outputs[2], mix.inputs[7])            # B
    nt.links.new(mix.outputs[2], emit.inputs["Color"])
    nt.links.new(emit.outputs["Emission"], out.inputs["Surface"])
    return mat


def label(text, x, y, size, alpha=0.55, z=-1.06):
    curve = bpy.data.curves.new(text, type="FONT")
    curve.body = text
    curve.size = size
    curve.align_x = "CENTER"
    obj = bpy.data.objects.new("t_" + text[:12], curve)
    obj.location = (x, y, z)
    bpy.context.scene.collection.objects.link(obj)

    mat = bpy.data.materials.new("label_" + text[:8])
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    emit = nt.nodes.new("ShaderNodeEmission")
    emit.inputs["Color"].default_value = (1, 1, 1, 1)
    emit.inputs["Strength"].default_value = alpha * 2.2
    nt.links.new(emit.outputs["Emission"], out.inputs["Surface"])
    obj.data.materials.append(mat)
    return obj


def build(rim_h=0.035, gap=0.03, wall=0.03):
    wipe()
    scene = bpy.context.scene

    # the whole look hinges on these two numbers. a physically thin sheet
    # sitting on its content barely bends anything; the ui look needs the rim
    # deeper and the content further away than a real overlay would be
    PANEL_RIM, PANEL_RIM_H, PANEL_WALL = 0.13, rim_h, wall
    GAP = gap
    back_z = -(PANEL_RIM_H + PANEL_WALL * 0.5 + GAP)

    plane = bpy.data.meshes.new("Backdrop")
    w, h = 4.0, 2.6
    plane.from_pydata(
        [(-w, -h, 0), (w, -h, 0), (w, h, 0), (-w, h, 0)], [], [(0, 1, 2, 3)])
    plane.update()
    back = bpy.data.objects.new("Backdrop", plane)
    back.location = (0, 0, back_z)
    scene.collection.objects.link(back)
    back.data.materials.append(backdrop_material())

    for i, word in enumerate(["REFRACTION", "DISPERSION", "FRESNEL", "CAUSTICS"]):
        label(word, 0.0, 0.78 - i * 0.52, 0.20, z=back_z + 0.002)

    mat = glass_material()

    panel = slab("Panel", a=0.95, b=0.54, r=0.20, n=4.0,
                 rim=PANEL_RIM, rim_h=PANEL_RIM_H, wall=PANEL_WALL)
    panel.location = (-0.55, 0.32, 0.0)
    panel.data.materials.append(mat)

    pill = slab("Pill", a=0.44, b=0.135, r=0.135, n=2.0,
                rim=0.075, rim_h=rim_h * 0.75, wall=wall * 0.7)
    pill.location = (0.86, -0.70, 0.0)
    pill.data.materials.append(mat)

    cam_data = bpy.data.cameras.new("Cam")
    cam_data.type = "ORTHO"
    cam_data.ortho_scale = 3.8
    cam = bpy.data.objects.new("Cam", cam_data)
    cam.location = (0, 0, 5)
    scene.collection.objects.link(cam)
    scene.camera = cam

    # key from the upper left, dim fill opposite, same as the web default
    key_data = bpy.data.lights.new("Key", type="AREA")
    key_data.energy = 400
    key_data.size = 1.6
    key = bpy.data.objects.new("Key", key_data)
    key.location = (-1.8, 1.5, 1.9)
    key.rotation_euler = (math.radians(40), math.radians(-26), math.radians(-12))
    scene.collection.objects.link(key)

    fill_data = bpy.data.lights.new("Fill", type="AREA")
    fill_data.energy = 110
    fill_data.size = 2.2
    fill = bpy.data.objects.new("Fill", fill_data)
    fill.location = (1.7, -1.4, 1.6)
    fill.rotation_euler = (math.radians(-42), math.radians(28), math.radians(12))
    scene.collection.objects.link(fill)

    # a gradient world so the rim has something to reflect instead of black
    world = bpy.data.worlds.new("W")
    scene.world = world
    world.use_nodes = True
    nt = world.node_tree
    nt.nodes.clear()
    wout = nt.nodes.new("ShaderNodeOutputWorld")
    bg = nt.nodes.new("ShaderNodeBackground")
    bg.inputs["Strength"].default_value = 0.8
    tex = nt.nodes.new("ShaderNodeTexGradient")
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].color = (0.04, 0.04, 0.07, 1)
    ramp.color_ramp.elements[1].color = (0.70, 0.76, 0.92, 1)
    mapping = nt.nodes.new("ShaderNodeMapping")
    mapping.inputs["Rotation"].default_value[1] = math.radians(90)
    coord = nt.nodes.new("ShaderNodeTexCoord")
    nt.links.new(coord.outputs["Generated"], mapping.inputs["Vector"])
    nt.links.new(mapping.outputs["Vector"], tex.inputs["Vector"])
    nt.links.new(tex.outputs["Fac"], ramp.inputs["Fac"])
    nt.links.new(ramp.outputs["Color"], bg.inputs["Color"])
    nt.links.new(bg.outputs["Background"], wout.inputs["Surface"])


def configure_render(samples=256, width=1600, height=900):
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = samples
    scene.cycles.use_denoising = True
    scene.cycles.max_bounces = 32
    scene.cycles.transmission_bounces = 24
    scene.cycles.transparent_max_bounces = 24
    scene.render.resolution_x = width
    scene.render.resolution_y = height
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = False
    scene.render.image_settings.file_format = "PNG"
    # AgX would desaturate everything; the pages this is compared against
    # render in plain sRGB
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"

    prefs = bpy.context.preferences.addons["cycles"].preferences
    picked = "CPU"
    for backend in ("OPTIX", "CUDA", "HIP", "ONEAPI"):
        try:
            prefs.compute_device_type = backend
        except TypeError:
            continue
        prefs.get_devices()
        if any(d.type == backend for d in prefs.devices):
            for d in prefs.devices:
                d.use = d.type == backend
            picked = backend
            break
    scene.cycles.device = "GPU" if picked != "CPU" else "CPU"
    print("cycles device: %s (%s)" % (scene.cycles.device, picked))


def solid_pass():
    """Opaque matte version. Glass hides geometry problems behind refraction,
    so when something looks wrong this is what to look at first."""
    mat = bpy.data.materials.new("Clay")
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (0.55, 0.57, 0.62, 1)
    bsdf.inputs["Roughness"].default_value = 0.35
    for name in ("Panel", "Pill"):
        obj = bpy.data.objects.get(name)
        if obj:
            obj.data.materials.clear()
            obj.data.materials.append(mat)


def mesh_report():
    import bmesh
    for name in ("Panel", "Pill"):
        obj = bpy.data.objects.get(name)
        if not obj:
            continue
        me = obj.data
        bm = bmesh.new()
        bm.from_mesh(me)
        loose = sum(1 for e in bm.edges if len(e.link_faces) != 2)
        print("MESH %s verts=%d polys=%d non_manifold_edges=%d up=%d down=%d"
              % (name, len(me.vertices), len(me.polygons), loose,
                 sum(1 for p in me.polygons if p.normal.z > 0.9),
                 sum(1 for p in me.polygons if p.normal.z < -0.9)))
        bm.free()


# how deep the rim goes and how far the content sits behind it.
# "thin" is what a real 2 mm sheet of glass on a screen would do.
# "ui" is roughly what the web build draws, and it is not physical.
VARIANTS = {
    "thin":   dict(rim_h=0.035, gap=0.03, wall=0.03),
    "medium": dict(rim_h=0.090, gap=0.10, wall=0.05),
    "ui":     dict(rim_h=0.160, gap=0.22, wall=0.07),
}


def render_to(name, samples):
    target = os.path.join(OUT_DIR, name)
    bpy.context.scene.render.filepath = target
    bpy.ops.render.render(write_still=True)
    print("wrote", target)


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    os.makedirs(OUT_DIR, exist_ok=True)

    if "--solid" in argv:
        build(**VARIANTS["medium"])
        mesh_report()
        solid_pass()
        configure_render(samples=96)
        render_to("glass_solid.png", 96)
        return

    if "--sweep" in argv:
        for key, kw in VARIANTS.items():
            build(**kw)
            configure_render(samples=320)
            render_to("glass_%s.png" % key, 320)
        return

    build(**VARIANTS["medium"])
    mesh_report()
    configure_render(samples=320)
    render_to("glass_ref.png", 320)


if __name__ == "__main__":
    main()
