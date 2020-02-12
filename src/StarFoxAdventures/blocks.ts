import { GfxDevice} from '../gfx/platform/GfxPlatform';
import { SceneContext } from '../SceneBase';
import { mat4 } from 'gl-matrix';
import ArrayBufferSlice from '../ArrayBufferSlice';
import { GX_VtxDesc, GX_VtxAttrFmt, GX_Array } from '../gx/gx_displaylist';
import { nArray } from '../util';
import * as GX from '../gx/gx_enum';
import { GXMaterialBuilder } from "../gx/GXMaterialBuilder";

import { ModelInstance, SFARenderer } from './render';
import { TextureCollection, SFATextureCollection, FalseTextureCollection } from './textures';
import { getSubdir } from './resource';
import { GameInfo } from './scenes';
import { IBlockCollection } from './maps';

export abstract class BlockFetcher {
    public abstract getBlock(mod: number, sub: number): ArrayBufferSlice | null;
}

export abstract class BlockRendererBase {
    public abstract addToRenderer(renderer: SFARenderer, modelMatrix: mat4): void;
}

export class BlockCollection implements IBlockCollection {
    gfxDevice: GfxDevice;
    blockRenderers: BlockRendererBase[] = []; // Address by blockRenderers[sub]
    blockFetcher: BlockFetcher;
    texColl: TextureCollection;

    constructor(private mod: number, private isAncient: boolean) {
    }

    public async create(device: GfxDevice, context: SceneContext, gameInfo: GameInfo) {
        this.gfxDevice = device;
        const dataFetcher = context.dataFetcher;
        const pathBase = gameInfo.pathBase;
        this.blockFetcher = await gameInfo.makeBlockFetcher(this.mod, dataFetcher, gameInfo);
        // const tex0Tab = await dataFetcher.fetchData(`${pathBase}/${subdir}/TEX0.tab`);
        // const tex0Bin = await dataFetcher.fetchData(`${pathBase}/${subdir}/TEX0.bin`);
        if (this.isAncient) {
            // const texTab = await dataFetcher.fetchData(`${pathBase}/TEX.tab`);
            // const texBin = await dataFetcher.fetchData(`${pathBase}/TEX.bin`);
            // this.texColl = new SFATextureCollection(texTab, texBin, this.isAncient);
            console.log(`creating ancient texture collection`);
            this.texColl = new FalseTextureCollection(device);
        } else {
            const subdir = getSubdir(this.mod, gameInfo);
            try {
                const tex1Tab = await dataFetcher.fetchData(`${pathBase}/${subdir}/TEX1.tab`);
                const tex1Bin = await dataFetcher.fetchData(`${pathBase}/${subdir}/TEX1.bin`);
                this.texColl = new SFATextureCollection(tex1Tab, tex1Bin, this.isAncient);
            } catch (e) {
                console.warn(`Failed to load textures for subdirectory ${subdir}. Using fake textures instead. Exception:`);
                console.error(e);
                this.texColl = new FalseTextureCollection(device);
            }
        }
    }

    public getBlockRenderer(device: GfxDevice, sub: number): BlockRendererBase | null {
        if (this.blockRenderers[sub] === undefined) {
            const uncomp = this.blockFetcher.getBlock(this.mod, sub);
            if (uncomp === null)
                return null;
            if (this.isAncient) {
                this.blockRenderers[sub] = new AncientBlockRenderer(device, uncomp, this.texColl);
            } else {
                this.blockRenderers[sub] = new BlockRenderer(device, uncomp, this.texColl);
            }
        }

        return this.blockRenderers[sub];
    }

    public getBlock(mod: number, sub: number): BlockRendererBase | null {
        return this.getBlockRenderer(this.gfxDevice, sub);
    }
}

// Reads bitfields by pulling from the low bits of each byte in sequence
class LowBitReader {
    dv: DataView
    offs: number
    num: number
    buf: number

    constructor(dv: DataView, offs: number = 0) {
        this.dv = dv;
        this.offs = offs;
        this.num = 0;
        this.buf = 0;
    }

    peek(bits: number): number {
        while (this.num < bits) {
            this.buf |= this.dv.getUint8(this.offs) << this.num
            this.offs++;
            this.num += 8;
        }
        return this.buf & ((1<<bits)-1);
    }

    drop(bits: number) {
        this.peek(bits); // Ensure buffer has bits to drop
        this.buf >>>= bits
        this.num -= bits
    }

    get(bits: number): number {
        const x = this.peek(bits)
        this.drop(bits)
        return x
    }
}

export class BlockRenderer implements BlockRendererBase {
    models: ModelInstance[] = [];
    yTranslate: number = 0;

    constructor(device: GfxDevice, blockData: ArrayBufferSlice, texColl: TextureCollection) {
        let offs = 0;
        const blockDv = blockData.createDataView();

        // FIXME: This field is NOT a model type and doesn't reliably indicate
        // the type of model.
        const modelType = blockDv.getUint16(4);
        let fields;
        switch (modelType) {
        case 0:
            fields = {
                texOffset: 0x54,
                texCount: 0xa0,
                posOffset: 0x58,
                posCount: 0x90,
                clrOffset: 0x5c,
                clrCount: 0x94,
                texcoordOffset: 0x60,
                texcoordCount: 0x96,
                shaderOffset: 0x64,
                shaderCount: 0xa0, // Polygon attributes and material information
                shaderSize: 0x40,
                listOffset: 0x68,
                listCount: 0x9f,
                listSize: 0x34,
                // FIXME: Yet another format occurs in sfademo/frontend!
                // numListBits: 6, // 6 is needed for mod12; 8 is needed for early crfort?!
                numListBits: 8, // ??? should be 6 according to decompilation of demo????
                numLayersOffset: 0x3b,
                bitstreamOffset: 0x74, // Whoa...
                // FIXME: There are three bitstreams, probably for opaque and transparent objects
                bitstreamByteCount: 0x84,
                oldVat: true,
                hasYTranslate: false,
                oldShaders: true,
            };
            break;
        case 8:
        case 264:
            fields = {
                texOffset: 0x54,
                texCount: 0xa0,
                posOffset: 0x58,
                posCount: 0x90,
                clrOffset: 0x5c,
                clrCount: 0x94,
                texcoordOffset: 0x60,
                texcoordCount: 0x96,
                shaderOffset: 0x64,
                shaderCount: 0xa2,
                shaderSize: 0x44,
                listOffset: 0x68,
                listCount: 0xa1, // TODO
                listSize: 0x1c,
                numListBits: 8,
                numLayersOffset: 0x41,
                bitstreamOffset: 0x78,
                bitstreamByteCount: 0x84,
                oldVat: false,
                hasYTranslate: true,
                oldShaders: false,
            };
            break;
        default:
            throw Error(`Model type ${modelType} not implemented`);
        }

        // @0x8: data size
        // @0xc: 4x3 matrix (placeholder; always zeroed in files)
        // @0x8e: y translation (up/down)

        //////////// TEXTURE STUFF TODO: move somewhere else

        const texOffset = blockDv.getUint32(fields.texOffset);
        const texCount = blockDv.getUint8(fields.texCount);
        // console.log(`Loading ${texCount} texture infos from 0x${texOffset.toString(16)}`);
        const texIds: number[] = [];
        for (let i = 0; i < texCount; i++) {
            const texIdFromFile = blockDv.getUint32(texOffset + i * 4);
            texIds.push(texIdFromFile);
        }
        // console.log(`tex ids: ${JSON.stringify(texIds)}`);

        //////////////////////////

        const posOffset = blockDv.getUint32(fields.posOffset);
        // const posCount = blockDv.getUint16(fields.posCount);
        // console.log(`Loading ${posCount} positions from 0x${posOffset.toString(16)}`);
        const vertBuffer = blockData.subarray(posOffset);

        const clrOffset = blockDv.getUint32(fields.clrOffset);
        // const clrCount = blockDv.getUint16(fields.clrCount);
        // console.log(`Loading ${clrCount} colors from 0x${clrOffset.toString(16)}`);
        const clrBuffer = blockData.subarray(clrOffset);

        const texcoordOffset = blockDv.getUint32(fields.texcoordOffset);
        // const texcoordCount = blockDv.getUint16(fields.texcoordCount);
        // console.log(`Loading ${coordCount} texcoords from 0x${coordOffset.toString(16)}`);
        const texcoordBuffer = blockData.subarray(texcoordOffset);

        const shaderOffset = blockDv.getUint32(fields.shaderOffset);
        const shaderCount = blockDv.getUint8(fields.shaderCount);
        // console.log(`Loading ${polyCount} polytypes from 0x${polyOffset.toString(16)}`);

        interface Shader {
            numLayers: number;
            tex0Num: number;
            tex1Num: number;
            hasTexCoord: boolean[];
            enableCull: boolean;
            flags: number;
        }

        const shaders: Shader[] = [];
        offs = shaderOffset;
        enum ShaderFlags {
            Cull = 0x8,
        }
        for (let i = 0; i < shaderCount; i++) {
            const shader = {
                numLayers: 0,
                hasTexCoord: nArray(8, () => false),
                tex0Num: -1,
                tex1Num: -1,
                enableCull: false,
                flags: 0,
            };
            // console.log(`parsing polygon attributes ${i} from 0x${offs.toString(16)}`);
            shader.tex0Num = blockDv.getUint32(offs + 0x24);
            //polyType.tex1Num = blockDv.getUint32(offs + 0x2C);
            //XXX: for demo
            shader.tex1Num = blockDv.getUint32(offs + 0x24 + 8); // ???
            // shader.tex1Num = blockDv.getUint32(offs + 0x2c); // ???
            // shader.tex1Num = blockDv.getUint32(offs + 0x34); // According to decompilation
            shader.numLayers = blockDv.getUint8(offs + fields.numLayersOffset);
            for (let j = 0; j < shader.numLayers; j++) {
                shader.hasTexCoord[j] = true;
            }
            shader.flags = blockDv.getUint32(offs + 0x3c);
            // FIXME: find this field's offset for demo files
            if (fields.oldShaders) {
                // FIXME: this is from decompilation but it doesn't seem to work in cloudtreasure...
                // shader.enableCull = (blockDv.getUint8(offs + 0x38) & 0x4) != 0;
                shader.enableCull = true;
            } else {
                shader.enableCull = (shader.flags & ShaderFlags.Cull) != 0;
            }
            
            // console.log(`PolyType: ${JSON.stringify(polyType)}`);
            // console.log(`PolyType tex0: ${decodedTextures[polyType.tex0Num]}, tex1: ${decodedTextures[polyType.tex1Num]}`);
            shaders.push(shader);
            offs += fields.shaderSize;
        }
        
        const vcd: GX_VtxDesc[] = [];
        const vat: GX_VtxAttrFmt[][] = nArray(8, () => []);
        for (let i = 0; i <= GX.Attr.MAX; i++) {
            vcd[i] = { type: GX.AttrType.NONE };
            for (let j = 0; j < 8; j++) {
                vat[j][i] = { compType: GX.CompType.U8, compShift: 0, compCnt: 0 };
            }
        }

        // vcd[GX.Attr.PNMTXIDX].type = GX.AttrType.DIRECT;
        vcd[GX.Attr.POS].type = GX.AttrType.DIRECT;
        vcd[GX.Attr.CLR0].type = GX.AttrType.DIRECT;
        vcd[GX.Attr.TEX0].type = GX.AttrType.DIRECT;

        // TODO: Implement normals and lighting
        vat[0][GX.Attr.POS] = { compType: GX.CompType.S16, compShift: 0, compCnt: GX.CompCnt.POS_XYZ };
        vat[0][GX.Attr.CLR0] = { compType: GX.CompType.RGBA8, compShift: 0, compCnt: GX.CompCnt.CLR_RGBA };
        vat[0][GX.Attr.TEX0] = { compType: GX.CompType.S16, compShift: 7, compCnt: GX.CompCnt.TEX_ST };
        
        vat[1][GX.Attr.POS] = { compType: GX.CompType.S16, compShift: 2, compCnt: GX.CompCnt.POS_XYZ };
        vat[1][GX.Attr.CLR0] = { compType: GX.CompType.RGBA8, compShift: 0, compCnt: GX.CompCnt.CLR_RGBA };
        vat[1][GX.Attr.TEX0] = { compType: GX.CompType.F32, compShift: 0, compCnt: GX.CompCnt.TEX_ST };
        
        vat[2][GX.Attr.POS] = { compType: GX.CompType.F32, compShift: 0, compCnt: GX.CompCnt.POS_XYZ };
        vat[2][GX.Attr.CLR0] = { compType: GX.CompType.RGBA8, compShift: 0, compCnt: GX.CompCnt.CLR_RGBA };
        vat[2][GX.Attr.TEX0] = { compType: GX.CompType.F32, compShift: 0, compCnt: GX.CompCnt.TEX_ST };
        vat[2][GX.Attr.TEX1] = { compType: GX.CompType.F32, compShift: 0, compCnt: GX.CompCnt.TEX_ST };

        vat[3][GX.Attr.POS] = { compType: GX.CompType.S16, compShift: 8, compCnt: GX.CompCnt.POS_XYZ };
        vat[3][GX.Attr.NBT] = { compType: GX.CompType.S8, compShift: 0, compCnt: GX.CompCnt.NRM_NBT };
        vat[3][GX.Attr.CLR0] = { compType: GX.CompType.RGBA4, compShift: 0, compCnt: GX.CompCnt.CLR_RGBA };
        vat[3][GX.Attr.TEX0] = { compType: GX.CompType.S16, compShift: 10, compCnt: GX.CompCnt.TEX_ST };
        vat[3][GX.Attr.TEX1] = { compType: GX.CompType.S16, compShift: 10, compCnt: GX.CompCnt.TEX_ST };
        vat[3][GX.Attr.TEX2] = { compType: GX.CompType.S16, compShift: 10, compCnt: GX.CompCnt.TEX_ST };
        vat[3][GX.Attr.TEX3] = { compType: GX.CompType.S16, compShift: 10, compCnt: GX.CompCnt.TEX_ST };
        
        vat[4][GX.Attr.POS] = { compType: GX.CompType.F32, compShift: 0, compCnt: GX.CompCnt.POS_XYZ };
        vat[4][GX.Attr.CLR0] = { compType: GX.CompType.RGBA8, compShift: 0, compCnt: GX.CompCnt.CLR_RGBA };
        vat[4][GX.Attr.TEX0] = { compType: GX.CompType.S16, compShift: 7, compCnt: GX.CompCnt.TEX_ST };

        vat[5][GX.Attr.POS] = { compType: GX.CompType.S16, compShift: fields.oldVat ? 0 : 3, compCnt: GX.CompCnt.POS_XYZ };
        vat[5][GX.Attr.CLR0] = { compType: GX.CompType.RGBA4, compShift: 0, compCnt: GX.CompCnt.CLR_RGBA };
        vat[5][GX.Attr.TEX0] = { compType: GX.CompType.S16, compShift: 8, compCnt: GX.CompCnt.TEX_ST };
        vat[5][GX.Attr.TEX1] = { compType: GX.CompType.S16, compShift: 8, compCnt: GX.CompCnt.TEX_ST };
        vat[5][GX.Attr.TEX2] = { compType: GX.CompType.S16, compShift: 8, compCnt: GX.CompCnt.TEX_ST };
        vat[5][GX.Attr.TEX3] = { compType: GX.CompType.S16, compShift: 8, compCnt: GX.CompCnt.TEX_ST };

        vat[6][GX.Attr.POS] = { compType: GX.CompType.S16, compShift: 8, compCnt: GX.CompCnt.POS_XYZ };
        vat[6][GX.Attr.CLR0] = { compType: GX.CompType.RGBA4, compShift: 0, compCnt: GX.CompCnt.CLR_RGBA };
        vat[6][GX.Attr.TEX0] = { compType: GX.CompType.S16, compShift: 10, compCnt: GX.CompCnt.TEX_ST };
        vat[6][GX.Attr.TEX1] = { compType: GX.CompType.S16, compShift: 10, compCnt: GX.CompCnt.TEX_ST };
        vat[6][GX.Attr.TEX2] = { compType: GX.CompType.S16, compShift: 10, compCnt: GX.CompCnt.TEX_ST };
        vat[6][GX.Attr.TEX3] = { compType: GX.CompType.S16, compShift: 10, compCnt: GX.CompCnt.TEX_ST };

        vat[7][GX.Attr.POS] = { compType: GX.CompType.S16, compShift: 0, compCnt: GX.CompCnt.POS_XYZ };
        vat[7][GX.Attr.CLR0] = { compType: GX.CompType.RGBA4, compShift: 0, compCnt: GX.CompCnt.CLR_RGBA };
        vat[7][GX.Attr.TEX0] = { compType: GX.CompType.S16, compShift: 10, compCnt: GX.CompCnt.TEX_ST };
        vat[7][GX.Attr.TEX1] = { compType: GX.CompType.S16, compShift: 10, compCnt: GX.CompCnt.TEX_ST };
        vat[7][GX.Attr.TEX2] = { compType: GX.CompType.S16, compShift: 10, compCnt: GX.CompCnt.TEX_ST };
        vat[7][GX.Attr.TEX3] = { compType: GX.CompType.S16, compShift: 10, compCnt: GX.CompCnt.TEX_ST };

        const listOffset = blockDv.getUint32(fields.listOffset);
        const listCount = blockDv.getUint8(fields.listCount);
        // console.log(`Loading ${chunkCount} display lists from 0x${chunkOffset.toString(16)}`);

        const bitstreamOffset = blockDv.getUint32(fields.bitstreamOffset);
        const bitstreamCount = blockDv.getUint16(fields.bitstreamByteCount);
        // console.log(`Loading ${bitsCount} bits from 0x${bitsOffset.toString(16)}`);

        if (fields.hasYTranslate) {
            this.yTranslate = blockDv.getInt16(0x8e);
        } else {
            this.yTranslate = 0;
        }

        const bits = new LowBitReader(blockDv, bitstreamOffset);
        let done = false;
        let curShader = 0;
        while (!done) {
            const opcode = bits.get(4);
            switch (opcode) {
            case 1: // Set polygon type
                curShader = bits.get(6);
                // console.log(`setting poly type ${curPolyType}`);
                break;
            case 2: // Geometry
                const listNum = bits.get(fields.numListBits);
                // console.log(`Drawing display list #${chunkNum}`);
                if (listNum >= listCount) {
                    console.warn(`Can't draw display list #${listNum} (out of range)`);
                    continue;
                }
                offs = listOffset + listNum * fields.listSize;
                const dlOffset = blockDv.getUint32(offs);
                const dlSize = blockDv.getUint16(offs + 4);
                // console.log(`DL offset 0x${dlOffset.toString(16)} size 0x${dlSize.toString(16)}`);
                const displayList = blockData.subarray(dlOffset, dlSize);

                const vtxArrays: GX_Array[] = [];
                vtxArrays[GX.Attr.POS] = { buffer: vertBuffer, offs: 0, stride: 6 /*getAttributeByteSize(vat[0], GX.Attr.POS)*/ };
                vtxArrays[GX.Attr.CLR0] = { buffer: clrBuffer, offs: 0, stride: 2 /*getAttributeByteSize(vat[0], GX.Attr.CLR0)*/ };
                for (let t = 0; t < 8; t++) {
                    vtxArrays[GX.Attr.TEX0 + t] = { buffer: texcoordBuffer, offs: 0, stride: 4 /*getAttributeByteSize(vat[0], GX.Attr.TEX0)*/ };
                }

                try {
                    const shader = shaders[curShader];
                    const newModel = new ModelInstance(vtxArrays, vcd, vat, displayList, shader.enableCull);

                    const mb = new GXMaterialBuilder('Basic');
                    if ((shader.flags & 0x40000000) || (shader.flags & 0x20000000)) {
                        mb.setBlendMode(GX.BlendMode.BLEND, GX.BlendFactor.SRCALPHA, GX.BlendFactor.INVSRCALPHA, GX.LogicOp.NOOP);
                        mb.setZMode(true, GX.CompareType.LEQUAL, false);
                        mb.setAlphaCompare(GX.CompareType.ALWAYS, 0, GX.AlphaOp.AND, GX.CompareType.ALWAYS, 0);
                    } else {
                        mb.setBlendMode(GX.BlendMode.NONE, GX.BlendFactor.ONE, GX.BlendFactor.ZERO, GX.LogicOp.NOOP);
                        mb.setZMode(true, GX.CompareType.LEQUAL, true);
                        if (((shader.flags & 0x400) == 0) || ((shader.flags & 0x80) != 0)) {
                            mb.setAlphaCompare(GX.CompareType.ALWAYS, 0, GX.AlphaOp.AND, GX.CompareType.ALWAYS, 0);
                        } else {
                            mb.setAlphaCompare(GX.CompareType.GREATER, 0, GX.AlphaOp.AND, GX.CompareType.GREATER, 0);
                        }
                    }
                    mb.setChanCtrl(GX.ColorChannelID.COLOR0A0, false, GX.ColorSrc.REG, GX.ColorSrc.VTX, 0, GX.DiffuseFunction.NONE, GX.AttenuationFunction.NONE);
                    mb.setCullMode(shader.enableCull ? GX.CullMode.BACK : GX.CullMode.NONE);
                    let tevStage = 0;
                    let texcoordId = GX.TexCoordID.TEXCOORD0;
                    let texmapId = GX.TexMapID.TEXMAP0;
                    let texGenSrc = GX.TexGenSrc.TEX0;
                    for (let i = 0; i < shader.numLayers; i++) {
                        mb.setTexCoordGen(texcoordId, GX.TexGenType.MTX2x4, texGenSrc, GX.TexGenMatrix.IDENTITY);

                        // mb.setTevKColor (does not exist)
                        // mb.setTevKColorSel(tevStage, GX.KonstColorSel.KCSEL_K0);
                        mb.setTevDirect(tevStage);
                        mb.setTevOrder(tevStage, GX.TexCoordID.TEXCOORD_NULL, GX.TexMapID.TEXMAP_NULL, GX.RasColorChannelID.COLOR0A0);
                        mb.setTevColorIn(tevStage, GX.CC.ZERO, GX.CC.ONE /*GX.CombineColorInput.KONST*/, GX.CC.RASC, GX.CC.ZERO);
                        mb.setTevAlphaIn(tevStage, GX.CA.ZERO, GX.CA.ZERO, GX.CA.ZERO, GX.CA.ZERO);
                        mb.setTevColorOp(tevStage, GX.TevOp.ADD, GX.TevBias.ZERO, GX.TevScale.SCALE_1, true, GX.Register.PREV);
                        mb.setTevAlphaOp(tevStage, GX.TevOp.ADD, GX.TevBias.ZERO, GX.TevScale.SCALE_1, true, GX.Register.PREV);

                        mb.setTevDirect(tevStage + 1);
                        mb.setTevOrder(tevStage + 1, GX.TexCoordID.TEXCOORD_NULL, GX.TexMapID.TEXMAP_NULL, GX.RasColorChannelID.COLOR0A0);
                        mb.setTevColorIn(tevStage + 1, GX.CC.CPREV, GX.CC.RASC, GX.CC.RASA, GX.CC.ZERO);
                        mb.setTevAlphaIn(tevStage + 1, GX.CA.ZERO, GX.CA.ZERO, GX.CA.ZERO, GX.CA.ZERO);
                        mb.setTevColorOp(tevStage + 1, GX.TevOp.ADD, GX.TevBias.ZERO, GX.TevScale.SCALE_1, true, GX.Register.PREV);
                        mb.setTevAlphaOp(tevStage + 1, GX.TevOp.ADD, GX.TevBias.ZERO, GX.TevScale.SCALE_1, true, GX.Register.PREV);

                        mb.setTevDirect(tevStage + 2);
                        mb.setTevOrder(tevStage + 2, texcoordId, texmapId, GX.RasColorChannelID.COLOR_ZERO /* GX_COLOR_NULL */);
                        mb.setTevColorIn(tevStage + 2, GX.CC.ZERO, GX.CC.CPREV, GX.CC.TEXC, GX.CC.ZERO);
                        mb.setTevAlphaIn(tevStage + 2, GX.CA.ZERO, GX.CA.ZERO, GX.CA.ZERO, GX.CA.TEXA);
                        mb.setTevColorOp(tevStage + 2, GX.TevOp.ADD, GX.TevBias.ZERO, GX.TevScale.SCALE_1, true, GX.Register.PREV);
                        mb.setTevAlphaOp(tevStage + 2, GX.TevOp.ADD, GX.TevBias.ZERO, GX.TevScale.SCALE_1, true, GX.Register.PREV);

                        tevStage += 3;
                        texcoordId++;
                        texmapId++;
                        texGenSrc++;
                    }
                    newModel.setMaterial(mb.finish());

                    newModel.setTextures([
                        texColl.getTexture(device, texIds[shader.tex0Num]),
                        texColl.getTexture(device, texIds[shader.tex1Num]),
                    ]);

                    this.models.push(newModel);
                } catch (e) {
                    console.error(e);
                }
                break;
            case 3: // Set vertex attributes
                const posDesc = bits.get(1);
                const colorDesc = bits.get(1);
                const texCoordDesc = bits.get(1);
                vcd[GX.Attr.POS].type = posDesc ? GX.AttrType.INDEX16 : GX.AttrType.INDEX8;
                vcd[GX.Attr.NRM].type = GX.AttrType.NONE; // Normal is not used in Star Fox Adventures (?)
                vcd[GX.Attr.CLR0].type = colorDesc ? GX.AttrType.INDEX16 : GX.AttrType.INDEX8;
                if (shaders[curShader].hasTexCoord[0]) {
                    // Note: texCoordDesc applies to all texture coordinates in the vertex
                    for (let t = 0; t < 8; t++) {
                        if (shaders[curShader].hasTexCoord[t]) {
                            vcd[GX.Attr.TEX0 + t].type = texCoordDesc ? GX.AttrType.INDEX16 : GX.AttrType.INDEX8;
                        } else {
                            vcd[GX.Attr.TEX0 + t].type = GX.AttrType.NONE;
                        }
                    }
                }
                break;
            case 4: // Set weights (skipped by SFA block renderer)
                const numWeights = bits.get(4);
                for (let i = 0; i < numWeights; i++) {
                    bits.get(8);
                }
                break;
            case 5: // End
                done = true;
                break;
            default:
                console.warn(`Skipping unknown model bits opcode ${opcode}`);
                break;
            }
        }
    }

    public addToRenderer(renderer: SFARenderer, modelMatrix: mat4) {
        for (let i = 0; i < this.models.length; i++) {
            const trans = mat4.create();
            mat4.fromTranslation(trans, [0, this.yTranslate, 0]);
            const matrix = mat4.create();
            mat4.mul(matrix, modelMatrix, trans);
            renderer.addModel(this.models[i], matrix);
        }
    }
}

export class AncientBlockRenderer implements BlockRendererBase {
    models: ModelInstance[] = [];
    yTranslate: number = 0;

    constructor(device: GfxDevice, blockData: ArrayBufferSlice, texColl: TextureCollection) {
        let offs = 0;
        const blockDv = blockData.createDataView();

        let fields = {
            texOffset: 0x58,
            posOffset: 0x5c,
            clrOffset: 0x60,
            texcoordOffset: 0x64,
            shaderOffset: 0x68,
            listOffsets: 0x6c,
            listSizes: 0x70,
            bitstreamOffset: 0x7c, // Whoa...
            texCount: 0xa0,
            posCount: 0x90,
            clrCount: 0x94,
            texcoordCount: 0x96,
            shaderCount: 0x9a, // Polygon attributes and material information
            shaderSize: 0x3c,
            listCount: 0x99,
            numListBits: 6,
            numLayersOffset: 0x3b,
            // FIXME: There are three bitstreams, probably for opaque and transparent objects
            bitstreamByteCount: 0x86,
            hasYTranslate: false,
            oldShaders: true,
        };

        // @0x8: data size
        // @0xc: 4x3 matrix (placeholder; always zeroed in files)
        // @0x8e: y translation (up/down)

        //////////// TEXTURE STUFF TODO: move somewhere else

        const texOffset = blockDv.getUint32(fields.texOffset);
        const texCount = blockDv.getUint8(fields.texCount);
        // console.log(`Loading ${texCount} texture infos from 0x${texOffset.toString(16)}`);
        const texIds: number[] = [];
        for (let i = 0; i < texCount; i++) {
            const texIdFromFile = blockDv.getUint32(texOffset + i * 4);
            // console.log(`texid ${i} = 0x${texIdFromFile.toString(16)}`);
            texIds.push(texIdFromFile);
        }
        // console.log(`tex ids: ${JSON.stringify(texIds)}`);

        //////////////////////////

        const posOffset = blockDv.getUint32(fields.posOffset);
        // const posCount = blockDv.getUint16(fields.posCount);
        // console.log(`Loading ${posCount} positions from 0x${posOffset.toString(16)}`);
        const vertBuffer = blockData.subarray(posOffset);

        const clrOffset = blockDv.getUint32(fields.clrOffset);
        // const clrCount = blockDv.getUint16(fields.clrCount);
        // console.log(`Loading ${clrCount} colors from 0x${clrOffset.toString(16)}`);
        const clrBuffer = blockData.subarray(clrOffset);

        const texcoordOffset = blockDv.getUint32(fields.texcoordOffset);
        // const texcoordCount = blockDv.getUint16(fields.texcoordCount);
        // console.log(`Loading ${coordCount} texcoords from 0x${coordOffset.toString(16)}`);
        const texcoordBuffer = blockData.subarray(texcoordOffset);

        const shaderOffset = blockDv.getUint32(fields.shaderOffset);
        const shaderCount = blockDv.getUint8(fields.shaderCount);
        // console.log(`Loading ${polyCount} polytypes from 0x${polyOffset.toString(16)}`);

        interface Shader {
            numLayers: number;
            tex0Num: number;
            tex1Num: number;
            hasTexCoord: boolean[];
            enableCull: boolean;
            flags: number;
        }

        const shaders: Shader[] = [];
        offs = shaderOffset;
        for (let i = 0; i < shaderCount; i++) {
            const shader = {
                numLayers: 0,
                hasTexCoord: nArray(8, () => false),
                tex0Num: -1,
                tex1Num: -1,
                enableCull: false,
                flags: 0,
            };
            // console.log(`parsing polygon attributes ${i} from 0x${offs.toString(16)}`);
            shader.tex0Num = blockDv.getUint32(offs + 0x24);
            //polyType.tex1Num = blockDv.getUint32(offs + 0x2C);
            //XXX: for demo
            shader.tex1Num = blockDv.getUint32(offs + 0x24 + 8); // ???
            // shader.tex1Num = blockDv.getUint32(offs + 0x2c); // ???
            // shader.tex1Num = blockDv.getUint32(offs + 0x34); // According to decompilation
            // shader.numLayers = blockDv.getUint8(offs + fields.numLayersOffset);
            shader.numLayers = 1;
            for (let j = 0; j < shader.numLayers; j++) {
                shader.hasTexCoord[j] = true;
            }
            shader.flags = blockDv.getUint32(offs + 0x3c);
            shader.enableCull = true; // FIXME
            
            // console.log(`PolyType: ${JSON.stringify(polyType)}`);
            // console.log(`PolyType tex0: ${decodedTextures[polyType.tex0Num]}, tex1: ${decodedTextures[polyType.tex1Num]}`);
            shaders.push(shader);
            offs += fields.shaderSize;
        }
        
        const vcd: GX_VtxDesc[] = [];
        const vat: GX_VtxAttrFmt[][] = nArray(8, () => []);
        for (let i = 0; i <= GX.Attr.MAX; i++) {
            vcd[i] = { type: GX.AttrType.NONE };
            for (let j = 0; j < 8; j++) {
                vat[j][i] = { compType: GX.CompType.U8, compShift: 0, compCnt: 0 };
            }
        }

        // vcd[GX.Attr.PNMTXIDX].type = GX.AttrType.DIRECT;
        vcd[GX.Attr.POS].type = GX.AttrType.DIRECT;
        vcd[GX.Attr.CLR0].type = GX.AttrType.DIRECT;
        vcd[GX.Attr.TEX0].type = GX.AttrType.DIRECT;

        // TODO: Implement normals and lighting
        vat[0][GX.Attr.POS] = { compType: GX.CompType.S16, compShift: 0, compCnt: GX.CompCnt.POS_XYZ };
        vat[0][GX.Attr.CLR0] = { compType: GX.CompType.RGBA8, compShift: 0, compCnt: GX.CompCnt.CLR_RGBA };
        vat[0][GX.Attr.TEX0] = { compType: GX.CompType.S16, compShift: 7, compCnt: GX.CompCnt.TEX_ST };
        
        vat[1][GX.Attr.POS] = { compType: GX.CompType.S16, compShift: 2, compCnt: GX.CompCnt.POS_XYZ };
        vat[1][GX.Attr.CLR0] = { compType: GX.CompType.RGBA8, compShift: 0, compCnt: GX.CompCnt.CLR_RGBA };
        vat[1][GX.Attr.TEX0] = { compType: GX.CompType.F32, compShift: 0, compCnt: GX.CompCnt.TEX_ST };
        
        vat[2][GX.Attr.POS] = { compType: GX.CompType.F32, compShift: 0, compCnt: GX.CompCnt.POS_XYZ };
        vat[2][GX.Attr.CLR0] = { compType: GX.CompType.RGBA8, compShift: 0, compCnt: GX.CompCnt.CLR_RGBA };
        vat[2][GX.Attr.TEX0] = { compType: GX.CompType.F32, compShift: 0, compCnt: GX.CompCnt.TEX_ST };
        vat[2][GX.Attr.TEX1] = { compType: GX.CompType.F32, compShift: 0, compCnt: GX.CompCnt.TEX_ST };

        vat[3][GX.Attr.POS] = { compType: GX.CompType.S16, compShift: 8, compCnt: GX.CompCnt.POS_XYZ };
        vat[3][GX.Attr.NBT] = { compType: GX.CompType.S8, compShift: 0, compCnt: GX.CompCnt.NRM_NBT };
        vat[3][GX.Attr.CLR0] = { compType: GX.CompType.RGBA4, compShift: 0, compCnt: GX.CompCnt.CLR_RGBA };
        vat[3][GX.Attr.TEX0] = { compType: GX.CompType.S16, compShift: 10, compCnt: GX.CompCnt.TEX_ST };
        vat[3][GX.Attr.TEX1] = { compType: GX.CompType.S16, compShift: 10, compCnt: GX.CompCnt.TEX_ST };
        vat[3][GX.Attr.TEX2] = { compType: GX.CompType.S16, compShift: 10, compCnt: GX.CompCnt.TEX_ST };
        vat[3][GX.Attr.TEX3] = { compType: GX.CompType.S16, compShift: 10, compCnt: GX.CompCnt.TEX_ST };
        
        vat[4][GX.Attr.POS] = { compType: GX.CompType.F32, compShift: 0, compCnt: GX.CompCnt.POS_XYZ };
        vat[4][GX.Attr.CLR0] = { compType: GX.CompType.RGBA8, compShift: 0, compCnt: GX.CompCnt.CLR_RGBA };
        vat[4][GX.Attr.TEX0] = { compType: GX.CompType.S16, compShift: 7, compCnt: GX.CompCnt.TEX_ST };

        vat[5][GX.Attr.POS] = { compType: GX.CompType.S16, compShift: 0, compCnt: GX.CompCnt.POS_XYZ };
        vat[5][GX.Attr.CLR0] = { compType: GX.CompType.RGBA4, compShift: 0, compCnt: GX.CompCnt.CLR_RGBA };
        vat[5][GX.Attr.TEX0] = { compType: GX.CompType.S16, compShift: 8, compCnt: GX.CompCnt.TEX_ST };
        vat[5][GX.Attr.TEX1] = { compType: GX.CompType.S16, compShift: 8, compCnt: GX.CompCnt.TEX_ST };
        vat[5][GX.Attr.TEX2] = { compType: GX.CompType.S16, compShift: 8, compCnt: GX.CompCnt.TEX_ST };
        vat[5][GX.Attr.TEX3] = { compType: GX.CompType.S16, compShift: 8, compCnt: GX.CompCnt.TEX_ST };

        vat[6][GX.Attr.POS] = { compType: GX.CompType.S16, compShift: 8, compCnt: GX.CompCnt.POS_XYZ };
        vat[6][GX.Attr.CLR0] = { compType: GX.CompType.RGBA4, compShift: 0, compCnt: GX.CompCnt.CLR_RGBA };
        vat[6][GX.Attr.TEX0] = { compType: GX.CompType.S16, compShift: 10, compCnt: GX.CompCnt.TEX_ST };
        vat[6][GX.Attr.TEX1] = { compType: GX.CompType.S16, compShift: 10, compCnt: GX.CompCnt.TEX_ST };
        vat[6][GX.Attr.TEX2] = { compType: GX.CompType.S16, compShift: 10, compCnt: GX.CompCnt.TEX_ST };
        vat[6][GX.Attr.TEX3] = { compType: GX.CompType.S16, compShift: 10, compCnt: GX.CompCnt.TEX_ST };

        vat[7][GX.Attr.POS] = { compType: GX.CompType.S16, compShift: 0, compCnt: GX.CompCnt.POS_XYZ };
        vat[7][GX.Attr.CLR0] = { compType: GX.CompType.RGBA4, compShift: 0, compCnt: GX.CompCnt.CLR_RGBA };
        vat[7][GX.Attr.TEX0] = { compType: GX.CompType.S16, compShift: 10, compCnt: GX.CompCnt.TEX_ST };
        vat[7][GX.Attr.TEX1] = { compType: GX.CompType.S16, compShift: 10, compCnt: GX.CompCnt.TEX_ST };
        vat[7][GX.Attr.TEX2] = { compType: GX.CompType.S16, compShift: 10, compCnt: GX.CompCnt.TEX_ST };
        vat[7][GX.Attr.TEX3] = { compType: GX.CompType.S16, compShift: 10, compCnt: GX.CompCnt.TEX_ST };

        const listOffsets = blockDv.getUint32(fields.listOffsets);
        const listSizes = blockDv.getUint32(fields.listSizes);
        const listCount = blockDv.getUint8(fields.listCount);
        // console.log(`Loading ${listCount} display lists from 0x${listOffsets.toString(16)} (sizes at 0x${listSizes.toString(16)})`);

        const bitstreamOffset = blockDv.getUint32(fields.bitstreamOffset);
        const bitstreamByteCount = blockDv.getUint16(fields.bitstreamByteCount);
        // console.log(`Loading ${bitstreamByteCount} bitstream bytes from 0x${bitstreamOffset.toString(16)}`);

        if (fields.hasYTranslate) {
            this.yTranslate = blockDv.getInt16(0x8e);
        } else {
            this.yTranslate = 0;
        }

        const bits = new LowBitReader(blockDv, bitstreamOffset);
        let done = false;
        let curShader = 0;
        while (!done) {
            const opcode = bits.get(4);
            switch (opcode) {
            case 1: // Set polygon type
                curShader = bits.get(6);
                // console.log(`setting poly type ${curPolyType}`);
                break;
            case 2: // Geometry
                const listNum = bits.get(fields.numListBits);
                // console.log(`Drawing display list #${chunkNum}`);
                if (listNum >= listCount) {
                    console.warn(`Can't draw display list #${listNum} (out of range)`);
                    continue;
                }
                offs = listOffsets + listNum * 4;
                const dlOffset = blockDv.getUint32(offs);
                offs = listSizes + listNum * 2
                const dlSize = blockDv.getUint16(offs);
                // console.log(`DL offset 0x${dlOffset.toString(16)} size 0x${dlSize.toString(16)}`);
                const displayList = blockData.subarray(dlOffset, dlSize);

                const vtxArrays: GX_Array[] = [];
                vtxArrays[GX.Attr.POS] = { buffer: vertBuffer, offs: 0, stride: 6 /*getAttributeByteSize(vat[0], GX.Attr.POS)*/ };
                vtxArrays[GX.Attr.CLR0] = { buffer: clrBuffer, offs: 0, stride: 2 /*getAttributeByteSize(vat[0], GX.Attr.CLR0)*/ };
                for (let t = 0; t < 8; t++) {
                    vtxArrays[GX.Attr.TEX0 + t] = { buffer: texcoordBuffer, offs: 0, stride: 4 /*getAttributeByteSize(vat[0], GX.Attr.TEX0)*/ };
                }

                try {
                    const shader = shaders[curShader];
                    const newModel = new ModelInstance(vtxArrays, vcd, vat, displayList, shader.enableCull);

                    const mb = new GXMaterialBuilder('Basic');
                    mb.setBlendMode(GX.BlendMode.BLEND, GX.BlendFactor.ONE, GX.BlendFactor.ZERO);
                    mb.setZMode(true, GX.CompareType.LESS, true);
                    mb.setChanCtrl(GX.ColorChannelID.COLOR0A0, false, GX.ColorSrc.REG, GX.ColorSrc.VTX, 0, GX.DiffuseFunction.NONE, GX.AttenuationFunction.NONE);
                    mb.setCullMode(shader.enableCull ? GX.CullMode.BACK : GX.CullMode.NONE);
                    let tevStage = 0;
                    let texcoordId = GX.TexCoordID.TEXCOORD0;
                    let texmapId = GX.TexMapID.TEXMAP0;
                    let texGenSrc = GX.TexGenSrc.TEX0;
                    for (let i = 0; i < shader.numLayers; i++) {
                        mb.setTexCoordGen(texcoordId, GX.TexGenType.MTX2x4, texGenSrc, GX.TexGenMatrix.IDENTITY);

                        // mb.setTevKColor (does not exist)
                        // mb.setTevKColorSel(tevStage, GX.KonstColorSel.KCSEL_K0);
                        mb.setTevDirect(tevStage);
                        mb.setTevOrder(tevStage, GX.TexCoordID.TEXCOORD_NULL, GX.TexMapID.TEXMAP_NULL, GX.RasColorChannelID.COLOR0A0);
                        mb.setTevColorIn(tevStage, GX.CC.ZERO, GX.CC.ONE /*GX.CombineColorInput.KONST*/, GX.CC.RASC, GX.CC.ZERO);
                        mb.setTevAlphaIn(tevStage, GX.CA.ZERO, GX.CA.ZERO, GX.CA.ZERO, GX.CA.ZERO);
                        mb.setTevColorOp(tevStage, GX.TevOp.ADD, GX.TevBias.ZERO, GX.TevScale.SCALE_1, true, GX.Register.PREV);
                        mb.setTevAlphaOp(tevStage, GX.TevOp.ADD, GX.TevBias.ZERO, GX.TevScale.SCALE_1, true, GX.Register.PREV);

                        mb.setTevDirect(tevStage + 1);
                        mb.setTevOrder(tevStage + 1, GX.TexCoordID.TEXCOORD_NULL, GX.TexMapID.TEXMAP_NULL, GX.RasColorChannelID.COLOR0A0);
                        mb.setTevColorIn(tevStage + 1, GX.CC.CPREV, GX.CC.RASC, GX.CC.RASA, GX.CC.ZERO);
                        mb.setTevAlphaIn(tevStage + 1, GX.CA.ZERO, GX.CA.ZERO, GX.CA.ZERO, GX.CA.ZERO);
                        mb.setTevColorOp(tevStage + 1, GX.TevOp.ADD, GX.TevBias.ZERO, GX.TevScale.SCALE_1, true, GX.Register.PREV);
                        mb.setTevAlphaOp(tevStage + 1, GX.TevOp.ADD, GX.TevBias.ZERO, GX.TevScale.SCALE_1, true, GX.Register.PREV);

                        mb.setTevDirect(tevStage + 2);
                        mb.setTevOrder(tevStage + 2, texcoordId, texmapId, GX.RasColorChannelID.COLOR_ZERO /* GX_COLOR_NULL */);
                        mb.setTevColorIn(tevStage + 2, GX.CC.ZERO, GX.CC.CPREV, GX.CC.TEXC, GX.CC.ZERO);
                        mb.setTevAlphaIn(tevStage + 2, GX.CA.ZERO, GX.CA.ZERO, GX.CA.ZERO, GX.CA.TEXA);
                        mb.setTevColorOp(tevStage + 2, GX.TevOp.ADD, GX.TevBias.ZERO, GX.TevScale.SCALE_1, true, GX.Register.PREV);
                        mb.setTevAlphaOp(tevStage + 2, GX.TevOp.ADD, GX.TevBias.ZERO, GX.TevScale.SCALE_1, true, GX.Register.PREV);

                        tevStage += 3;
                        texcoordId++;
                        texmapId++;
                        texGenSrc++;
                    }
                    newModel.setMaterial(mb.finish());

                    newModel.setTextures([
                        texColl.getTexture(device, texIds[shader.tex0Num]),
                        // texColl.getTexture(device, texIds[shader.tex1Num]),
                    ]);

                    this.models.push(newModel);
                } catch (e) {
                    console.error(e);
                }
                break;
            case 3: // Set vertex attributes
                const posDesc = bits.get(1);
                const colorDesc = bits.get(1);
                const texCoordDesc = bits.get(1);
                vcd[GX.Attr.POS].type = posDesc ? GX.AttrType.INDEX16 : GX.AttrType.INDEX8;
                vcd[GX.Attr.NRM].type = GX.AttrType.NONE; // Normal is not used in Star Fox Adventures (?)
                vcd[GX.Attr.CLR0].type = colorDesc ? GX.AttrType.INDEX16 : GX.AttrType.INDEX8;
                if (shaders[curShader].hasTexCoord[0]) {
                    // Note: texCoordDesc applies to all texture coordinates in the vertex
                    for (let t = 0; t < 8; t++) {
                        if (shaders[curShader].hasTexCoord[t]) {
                            vcd[GX.Attr.TEX0 + t].type = texCoordDesc ? GX.AttrType.INDEX16 : GX.AttrType.INDEX8;
                        } else {
                            vcd[GX.Attr.TEX0 + t].type = GX.AttrType.NONE;
                        }
                    }
                }
                break;
            case 4: // Set weights (skipped by SFA block renderer)
                const numWeights = bits.get(4);
                for (let i = 0; i < numWeights; i++) {
                    bits.get(8);
                }
                break;
            case 5: // End
                done = true;
                break;
            default:
                console.warn(`Skipping unknown model bits opcode ${opcode}`);
                break;
            }
        }
    }

    public addToRenderer(renderer: SFARenderer, modelMatrix: mat4) {
        for (let i = 0; i < this.models.length; i++) {
            const trans = mat4.create();
            mat4.fromTranslation(trans, [0, this.yTranslate, 0]);
            const matrix = mat4.create();
            mat4.mul(matrix, modelMatrix, trans);
            renderer.addModel(this.models[i], matrix);
        }
    }
}
