import bb from "bit-buffer";
import { v2 } from "./utils/v2";
import { GameObjectDefs } from "./defs/gameObjectDefs";
import { MapObjectDefs } from "./defs/mapObjectDefs";
import { math } from "./utils/math";
import { GameConfig } from "./gameConfig";
import GameObject from "./utils/gameObject";

function createTypeSerialization(type, typeList, bitsPerType) {
    const typeMap = new ConfigTypeMap(bitsPerType);

    const types = Object.keys(typeList);
    // assert(types.length <= typeMap.maxId, `${type} contains ${types.length} types, max ${typeMap.maxId}`);
    for (let i = 0; i < types.length; i++) {
        typeMap.addType(types[i]);
    }

    if (DEV_MODE) {
        console.log(`Used ${typeMap.nextId} / ${typeMap.maxId} ${type} types`);
    }

    // Create serialization functions
    bb.BitStream.prototype[`write${type}Type`] = function(v) {
        this.writeBits(typeMap.typeToId(v), bitsPerType);
    };
    bb.BitStream.prototype[`read${type}Type`] = function() {
        return typeMap.idToType(this.readBits(bitsPerType));
    };

    return typeMap;
}

function getPlayerStatusUpdateRate(factionMode) {
    if (factionMode) {
        return 0.5;
    } else {
        return 0.25;
    }
}

function deserializeActivePlayer(e, t) {
    t.healthDirty = e.readBoolean();
    if (t.healthDirty) {
        t.health = e.readFloat(0, 100, 8);
    }
    t.boostDirty = e.readBoolean();
    if (t.boostDirty) {
        t.boost = e.readFloat(0, 100, 8);
    }
    t.zoomDirty = e.readBoolean();
    if (t.zoomDirty) {
        t.zoom = e.readUint8();
    }
    t.actionDirty = e.readBoolean();
    if (t.actionDirty) {
        t.action = {};
        t.action.time = e.readFloat(0, Constants.ActionMaxDuration, 8);
        t.action.duration = e.readFloat(0, Constants.ActionMaxDuration, 8);
        t.action.targetId = e.readUint16();
    }
    t.inventoryDirty = e.readBoolean();
    if (t.inventoryDirty) {
        t.scope = e.readGameType();
        t.inventory = {};
        for (
            let r = Object.keys(GameConfig.bagSizes), a = 0;
            a < r.length;
            a++
        ) {
            const i = r[a];
            let o = 0;
            if (e.readBoolean()) {
                o = e.readBits(9);
            }
            t.inventory[i] = o;
        }
    }
    t.weapsDirty = e.readBoolean();
    if (t.weapsDirty) {
        t.curWeapIdx = e.readBits(2);
        t.weapons = [];
        for (let s = 0; s < GameConfig.WeaponSlot.Count; s++) {
            const n = {};
            n.type = e.readGameType();
            n.ammo = e.readUint8();
            t.weapons.push(n);
        }
    }
    t.spectatorCountDirty = e.readBoolean();
    if (t.spectatorCountDirty) {
        t.spectatorCount = e.readUint8();
    }
    e.readAlignToNextByte();
}

function deserializePlayerStatus(e, t) {
    t.players = [];
    for (let r = e.readUint8(), a = 0; a < r; a++) {
        const i = {};
        i.hasData = e.readBoolean();
        if (i.hasData) {
            i.pos = e.readVec(0, 0, 1024, 1024, 11);
            i.visible = e.readBoolean();
            i.dead = e.readBoolean();
            i.downed = e.readBoolean();
            i.role = "";
            if (e.readBoolean()) {
                i.role = e.readGameType();
            }
        }
        t.players.push(i);
    }
    e.readAlignToNextByte();
}

function deserializeGroupStatus(e, t) {
    t.players = [];
    for (let r = e.readUint8(), a = 0; a < r; a++) {
        const i = {};
        i.health = e.readFloat(0, 100, 7);
        i.disconnected = e.readBoolean();
        t.players.push(i);
    }
}

function deserializePlayerInfos(e, t) {
    t.playerId = e.readUint16();
    t.teamId = e.readUint8();
    t.groupId = e.readUint8();
    t.name = e.readString();
    t.loadout = {};
    t.loadout.heal = e.readGameType();
    t.loadout.boost = e.readGameType();
    e.readAlignToNextByte();
}

function deserializeGasData(s, data) {
    data.mode = s.readUint8();
    data.duration = s.readFloat32();
    data.posOld = s.readVec(0, 0, 1024, 1024, 16);
    data.posNew = s.readVec(0, 0, 1024, 1024, 16);
    data.radOld = s.readFloat(0, 2048, 16);
    data.radNew = s.readFloat(0, 2048, 16);
}

function deserializeMapRiver(e, t) {
    t.width = e.readFloat32();
    t.looped = e.readUint8();
    t.points = [];
    for (let r = e.readUint8(), a = 0; a < r; a++) {
        const i = e.readVec(0, 0, 1024, 1024, 16);
        t.points.push(i);
    }
}

function deserializeMapPlaces(e, t) {
    t.name = e.readString();
    t.pos = e.readVec(0, 0, 1024, 1024, 16);
}

function deserializeMapGroundPatch(e, t) {
    t.min = e.readVec(0, 0, 1024, 1024, 16);
    t.max = e.readVec(0, 0, 1024, 1024, 16);
    t.color = e.readUint32();
    t.roughness = e.readFloat32();
    t.offsetDist = e.readFloat32();
    t.order = e.readBits(7);
    t.useAsMapShape = e.readBoolean();
}

function deserializeMapObj(e, t) {
    t.pos = e.readVec(0, 0, 1024, 1024, 16);
    t.scale = e.readFloat(
        Constants.MapObjectMinScale,
        Constants.MapObjectMaxScale,
        8
    );
    t.type = e.readMapType();
    t.ori = e.readBits(2);
    e.readBits(2);
}

const DEV_MODE = false;
bb.BitStream.prototype.writeBytes = function(src, offset, length) {
    // assert(this._index % 8 == 0);
    const data = new Uint8Array(src._view._view.buffer, offset, length);
    this._view._view.set(data, this._index / 8);
    this._index += length * 8;
};

bb.BitStream.prototype.writeString = bb.BitStream.prototype.writeASCIIString;
bb.BitStream.prototype.readString = bb.BitStream.prototype.readASCIIString;

bb.BitStream.prototype.writeFloat = function(f, min, max, bits) {
    // assert(bits > 0 && bits < 31);
    // assert(f >= min && f <= max);
    const range = (1 << bits) - 1;
    const x = math.clamp(f, min, max);
    const t = (x - min) / (max - min);
    const v = t * range + 0.5;
    this.writeBits(v, bits);
};

bb.BitStream.prototype.readFloat = function(min, max, bits) {
    // assert(bits > 0 && bits < 31);
    const range = (1 << bits) - 1;
    const x = this.readBits(bits);
    const t = x / range;
    const v = min + t * (max - min);
    return v;
};

bb.BitStream.prototype.writeVec = function(v, minX, minY, maxX, maxY, bits) {
    this.writeFloat(v.x, minX, maxX, bits);
    this.writeFloat(v.y, minY, maxY, bits);
};

bb.BitStream.prototype.readVec = function(minX, minY, maxX, maxY, bits) {
    return v2.create(this.readFloat(minX, maxX, bits), this.readFloat(minY, maxY, bits));
};

const kUnitEps = 1.0001;
bb.BitStream.prototype.writeUnitVec = function(v, bits) {
    this.writeVec(v, -kUnitEps, -kUnitEps, kUnitEps, kUnitEps, bits);
};

bb.BitStream.prototype.readUnitVec = function(bits) {
    return this.readVec(-kUnitEps, -kUnitEps, kUnitEps, kUnitEps, bits);
};

bb.BitStream.prototype.writeVec32 = function(v) {
    this.writeFloat32(v.x);
    this.writeFloat32(v.y);
};

bb.BitStream.prototype.readVec32 = function() {
    return v2.create(this.readFloat32(), this.readFloat32());
};

bb.BitStream.prototype.writeAlignToNextByte = function() {
    const pad = 8 - this.index % 8;
    if (pad < 8) {
        this.writeBits(0, pad);
    }
};

bb.BitStream.prototype.readAlignToNextByte = function() {
    const pad = 8 - this.index % 8;
    if (pad < 8) {
        this.readBits(pad);
    }
};

//
// Map type strings to integers for more efficient serialization.
//

class ConfigTypeMap {
    constructor(typeBits) {
        this._typeToId = {};
        this._idToType = {};
        this.nextId = 0;
        this.maxId = 2 ** typeBits;

        this.addType("");
    }

    addType(type) {
        // assert(this._typeToId[type] === undefined, `Type ${type} has already been defined!`);
        // assert(this.nextId < this.maxId);
        this._typeToId[type] = this.nextId;
        this._idToType[this.nextId] = type;
        this.nextId++;
    }

    typeToId(type) {
        const id = this._typeToId[type];
        // assert(id !== undefined, `Invalid type ${type}`);
        return id;
    }

    idToType(id) {
        const type = this._idToType[id];
        if (type === undefined) {
            console.error("Invalid id given to idToType", id, "max", Object.keys(this._idToType).length);
        }
        return type;
    }
}

createTypeSerialization("Game", GameObjectDefs, 10);
createTypeSerialization("Map", MapObjectDefs, 12);

//
// MsgStream
//

class MsgStream {
    constructor(buf) {
        let arrayBuf = buf instanceof ArrayBuffer ? buf : null;
        if (arrayBuf == null) {
            arrayBuf = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        }
        this.valid = arrayBuf != null;
        if (this.valid) {
            this.arrayBuf = arrayBuf;
            this.stream = new bb.BitStream(arrayBuf);
        } else {
            console.log("Invalid buf type", typeof buf === "undefined" ? "undefined" : _typeof(buf));
            if (typeof buf === "string") {
                console.log(`String contents: ${buf.substring(0, 1024)}`);
            }
        }
    }

    getBuffer() {
        return new Uint8Array(this.arrayBuf, 0, this.stream.byteIndex);
    }

    getStream() {
        return this.stream;
    }

    serializeMsg(type, msg) {
        // assert(this.stream.index % 8 == 0);
        this.stream.writeUint8(type);
        msg.serialize(this.stream);
        // assert(this.stream.index % 8 == 0);
    }

    serializeMsgStream(type, stream) {
        // assert(this.stream.index % 8 == 0 && stream.index % 8 == 0);
        this.stream.writeUint8(type);
        this.stream.writeBytes(stream, 0, stream.index / 8);
    }

    deserializeMsgType() {
        if (this.stream.length - this.stream.byteIndex * 8 >= 1) {
            return this.stream.readUint8();
        }
        return MsgType.None;
    }
}

const Constants = {
    MapNameMaxLen: 24,
    PlayerNameMaxLen: 16,
    MouseMaxDist: 64,
    SmokeMaxRad: 10,
    ActionMaxDuration: 8.5,
    AirstrikeZoneMaxRad: 256,
    AirstrikeZoneMaxDuration: 60,
    PlayerMinScale: 0.75,
    PlayerMaxScale: 2,
    MapObjectMinScale: 0.125,
    MapObjectMaxScale: 2.5,
    MaxPerks: 8,
    MaxMapIndicators: 16
};

const ObjectSerializeFns = {};

function setSerializeFns(type, serializedFullSize, serializePart, serializeFull, deserializePart, deserializeFull) {
    ObjectSerializeFns[type] = {
        serializedFullSize,
        serializePart,
        serializeFull,
        deserializePart,
        deserializeFull
    };
}

setSerializeFns(
    GameObject.Type.Player,
    32,
    (s, t) => {
        s.writeVec(t.pos, 0, 0, 1024, 1024, 16);
        s.writeUnitVec(t.dir, 8);
    },
    (s, t) => { },
    (s, t) => {
        t.ie = s.readVec(0, 0, 1024, 1024, 16); // position
        t.oe = s.readUnitVec(8); // rotation
    },
    (s, t) => {
        t.se = s.readGameType(); // outfit
        t.ne = s.readGameType(); // pack
        t.le = s.readGameType(); // helmet
        t.ce = s.readGameType(); // chest
        t.me = s.readGameType(); // active weapon

        t.pe = s.readBits(2); // layer
        t.he = s.readBoolean(); // dead
        t.ue = s.readBoolean(); // downed

        t.ge = s.readBits(3); // anim type
        t.ye = s.readBits(3); // anim seq
        t.we = s.readBits(3); // action type
        t.fe = s.readBits(3); // action seq

        t._e = s.readBoolean(); // wearing pan
        t.be = s.readBoolean(); // heal effect
        t.xe = s.readBoolean(); // frozen
        t.Se = s.readBits(2); // frozen ori
        t.ve = 0;
        t.ke = -1;
        if (s.readBoolean()) {
            // has haste
            t.ve = s.readBits(3); // haste type
            t.ke = s.readBits(3); // haste seq
        }
        const hasActionItem = s.readBoolean(); // has action item
        t.ze = hasActionItem ? s.readGameType() : ""; // action item

        const hasScale = s.readBoolean(); // scale dirty
        t.Ie = hasScale
            ? s.readFloat(Constants.PlayerMinScale, Constants.PlayerMaxScale, 8)
            : 1;
        const hasRole = s.readBoolean();
        t.Te = hasRole ? s.readGameType() : "";
        t.Me = [];
        const hasPerks = s.readBoolean();
        if (hasPerks) {
            const perkCount = s.readBits(3);
            for (let i = 0; i < perkCount; i++) {
                const type = s.readGameType();
                const droppable = s.readBoolean();
                t.Me.push({
                    type,
                    droppable
                });
            }
        }
        s.readAlignToNextByte();
    }
);
setSerializeFns(
    GameObject.Type.Obstacle,
    0,
    (s, t) => {
        s.writeVec(t.pos, 0, 0, 1024, 1024, 16);
        s.writeBits(t.ori, 2);
        s.writeFloat(
            t.scale,
            Constants.MapObjectMinScale,
            Constants.MapObjectMaxScale,
            8
        );
        s.writeBits(0, 6);
    },
    (s, t) => { },
    (s, t) => {
        t.pos = s.readVec(0, 0, 1024, 1024, 16);
        t.ori = s.readBits(2);
        t.scale = s.readFloat(
            Constants.MapObjectMinScale,
            Constants.MapObjectMaxScale,
            8
        );
        s.readBits(6);
    },
    (s, t) => {
        t.healthT = s.readFloat(0, 1, 8);
        t.type = s.readMapType();
        t.layer = s.readBits(2);
        t.dead = s.readBoolean();
        t.isDoor = s.readBoolean();
        if (t.isDoor) {
            t.door = {};
            t.door.open = s.readBoolean();
            t.door.canUse = s.readBoolean();
            t.door.locked = s.readBoolean();
            t.door.seq = s.readBits(5);
        }
        t.isButton = s.readBoolean();
        if (t.isButton) {
            t.button = {};
            t.button.onOff = s.readBoolean();
            t.button.canUse = s.readBoolean();
            t.button.seq = s.readBits(6);
        }
        t.isPuzzlePiece = s.readBoolean();
        if (t.isPuzzlePiece) {
            t.parentBuildingId = s.readUint16();
        }
        t.isSkin = s.readBoolean();
        if (t.isSkin) {
            t.skinPlayerId = s.readUint16();
        }
        s.readBits(5);
    }
);
setSerializeFns(
    GameObject.Type.Building,
    0,
    (s, t) => { },
    (s, t) => { },
    (s, t) => {
        t.ceilingDead = s.readBoolean();
        t.occupied = s.readBoolean();
        t.ceilingDamaged = s.readBoolean();
        t.hasPuzzle = s.readBoolean();
        if (t.hasPuzzle) {
            t.puzzleSolved = s.readBoolean();
            t.puzzleErrSeq = s.readBits(7);
        }
        s.readBits(4);
    },
    (s, t) => {
        t.pos = s.readVec(0, 0, 1024, 1024, 16);
        t.type = s.readMapType();
        t.ori = s.readBits(2);
        t.layer = s.readBits(2);
    }
);
setSerializeFns(
    GameObject.Type.Structure,
    0,
    (s, t) => { },
    (s, t) => {
        s.writeVec(t.pos, 0, 0, 1024, 1024, 16);
        s.writeMapType(t.type);
        s.writeBits(t.ori, 2);
        s.writeBoolean(t.interiorSoundEnabled);
        s.writeBoolean(t.interiorSoundAlt);
        for (let r = 0; r < GameConfig.structureLayerCount; r++) {
            s.writeUint16(t.layerObjIds[r]);
        }
    },
    (s, t) => { },
    (s, t) => {
        t.pos = s.readVec(0, 0, 1024, 1024, 16);
        t.type = s.readMapType();
        t.ori = s.readBits(2);
        t.interiorSoundEnabled = s.readBoolean();
        t.interiorSoundAlt = s.readBoolean();
        t.layerObjIds = [];
        for (let r = 0; r < GameConfig.structureLayerCount; r++) {
            const a = s.readUint16();
            t.layerObjIds.push(a);
        }
    }
);
setSerializeFns(
    GameObject.Type.LootSpawner,
    0,
    (s, t) => {
        s.writeVec(t.pos, 0, 0, 1024, 1024, 16);
        s.writeMapType(t.type);
        s.writeBits(t.layer, 2);
        s.writeBits(0, 2);
    },
    (s, t) => { },
    (s, t) => {
        t.pos = s.readVec(0, 0, 1024, 1024, 16);
        t.type = s.readMapType();
        t.layer = s.readBits(2);
        s.readBits(2);
    },
    (s, t) => { }
);
setSerializeFns(
    GameObject.Type.Loot,
    5,
    (s, t) => {
        s.writeVec(t.pos, 0, 0, 1024, 1024, 16);
    },
    (s, t) => {
        s.writeGameType(t.type);
        s.writeUint8(t.count);
        s.writeBits(t.layer, 2);
        s.writeBoolean(t.isOld);
        s.writeBoolean(t.isPreloadedGun);
        s.writeBoolean(t.ownerId != 0);
        if (t.ownerId != 0) {
            s.writeUint16(t.ownerId);
        }
        s.writeBits(0, 1);
    },
    (s, t) => {
        t.pos = s.readVec(0, 0, 1024, 1024, 16);
    },
    (s, t) => {
        t.type = s.readGameType();
        t.count = s.readUint8();
        t.layer = s.readBits(2);
        t.isOld = s.readBoolean();
        t.isPreloadedGun = s.readBoolean();
        t.hasOwner = s.readBoolean();
        if (t.hasOwner) {
            t.ownerId = s.readUint16();
        }
        s.readBits(1);
    }
);
setSerializeFns(
    GameObject.Type.DeadBody,
    0,
    (s, t) => {
        s.writeVec(t.pos, 0, 0, 1024, 1024, 16);
    },
    (s, t) => {
        s.writeUint8(t.layer);
        s.writeUint16(t.playerId);
    },
    (s, t) => {
        t.pos = s.readVec(0, 0, 1024, 1024, 16);
    },
    (s, t) => {
        t.layer = s.readUint8();
        t.playerId = s.readUint16();
    }
);
setSerializeFns(
    GameObject.Type.Decal,
    0,
    (s, t) => { },
    (s, t) => {
        s.writeVec(t.pos, 0, 0, 1024, 1024, 16);
        s.writeFloat(
            t.scale,
            Constants.MapObjectMinScale,
            Constants.MapObjectMaxScale,
            8
        );
        s.writeMapType(t.type);
        s.writeBits(t.ori, 2);
        s.writeBits(t.layer, 2);
        s.writeUint8(t.goreKills);
    },
    (s, t) => { },
    (s, t) => {
        t.pos = s.readVec(0, 0, 1024, 1024, 16);
        t.scale = s.readFloat(
            Constants.MapObjectMinScale,
            Constants.MapObjectMaxScale,
            8
        );
        t.type = s.readMapType();
        t.ori = s.readBits(2);
        t.layer = s.readBits(2);
        t.goreKills = s.readUint8();
    }
);
setSerializeFns(
    GameObject.Type.Projectile,
    0,
    (s, t) => {
        s.writeVec(t.pos, 0, 0, 1024, 1024, 16);
        s.writeFloat(t.posZ, 0, GameConfig.projectile.maxHeight, 10);
        s.writeUnitVec(t.dir, 7);
    },
    (s, t) => {
        s.writeGameType(t.type);
        s.writeBits(t.layer, 2);
        s.writeBits(0, 4);
    },
    (s, t) => {
        t.pos = s.readVec(0, 0, 1024, 1024, 16);
        t.posZ = s.readFloat(0, GameConfig.projectile.maxHeight, 10);
        t.dir = s.readUnitVec(7);
    },
    (s, t) => {
        t.type = s.readGameType();
        t.layer = s.readBits(2);
        s.readBits(4);
    }
);
setSerializeFns(
    GameObject.Type.Smoke,
    0,
    (s, t) => {
        s.writeVec(t.pos, 0, 0, 1024, 1024, 16);
        s.writeFloat(t.rad, 0, Constants.SmokeMaxRad, 8);
    },
    (s, t) => {
        s.writeBits(t.layer, 2);
        s.writeBits(t.interior, 6);
    },
    (s, t) => {
        t.pos = s.readVec(0, 0, 1024, 1024, 16);
        t.rad = s.readFloat(0, Constants.SmokeMaxRad, 8);
    },
    (s, t) => {
        t.layer = s.readBits(2);
        t.interior = s.readBits(6);
    }
);
setSerializeFns(
    GameObject.Type.Airdrop,
    0,
    (s, t) => {
        s.writeFloat(t.fallT, 0, 1, 7);
        s.writeBoolean(t.landed);
    },
    (s, t) => {
        s.writeVec(t.pos, 0, 0, 1024, 1024, 16);
    },
    (s, t) => {
        t.fallT = s.readFloat(0, 1, 7);
        t.landed = s.readBoolean();
    },
    (s, t) => {
        t.pos = s.readVec(0, 0, 1024, 1024, 16);
    }
);

const MsgType = {
    None: 0,
    Join: 1,
    Disconnect: 2,
    Input: 3,
    Edit: 4,
    Joined: 5,
    Update: 6,
    Kill: 7,
    GameOver: 8,
    Pickup: 9,
    Map: 10,
    Spectate: 11,
    DropItem: 12,
    Emote: 13,
    PlayerStats: 14,
    AdStatus: 15,
    Loadout: 16,
    RoleAnnouncement: 17,
    Stats: 18,
    UpdatePass: 19,
    AliveCounts: 20,
    PerkModeRoleSelect: 21
};

class JoinMsg {
    constructor() {
        this.protocol = 0;
        this.matchPriv = "";
        this.loadoutPriv = "";
        this.questPriv = "";
        this.name = "";
        this.useTouch = false;
        this.isMobile = false;
        this.proxy = false;
        this.otherProxy = false;
        this.bot = false;
    }

    serialize(s) {
        s.writeUint32(this.protocol);
        s.writeString(this.matchPriv);
        s.writeString(this.loadoutPriv);
        s.writeString(this.questPriv);
        s.writeString(this.name, Constants.PlayerNameMaxLen);
        s.writeBoolean(this.useTouch);
        s.writeBoolean(this.isMobile);
        s.writeBoolean(this.proxy);
        s.writeBoolean(this.otherProxy);
        s.writeBoolean(this.bot);
        s.writeAlignToNextByte();
    }
}

class DisconnectMsg {
    constructor() {
        this.reason = "";
    }

    deserialize(s) {
        this.reason = s.readString();
    }
}

class InputMsg {
    constructor() {
        this.seq = 0;
        this.moveLeft = false;
        this.moveRight = false;
        this.moveUp = false;
        this.moveDown = false;
        this.shootStart = false;
        this.shootHold = false;
        this.portrait = false;
        this.touchMoveActive = false;
        this.touchMoveDir = v2.create(1, 0);
        this.touchMoveLen = 255;
        this.toMouseDir = v2.create(1, 0);
        this.toMouseLen = 0;
        this.inputs = [];
        this.useItem = "";
    }

    addInput(e) {
        if (
            this.inputs.length < 7 &&
            !this.inputs.includes(e)
        ) {
            this.inputs.push(e);
        }
    }

    serialize(s) {
        s.writeUint8(this.seq);
        s.writeBoolean(this.moveLeft);
        s.writeBoolean(this.moveRight);
        s.writeBoolean(this.moveUp);
        s.writeBoolean(this.moveDown);
        s.writeBoolean(this.shootStart);
        s.writeBoolean(this.shootHold);
        s.writeBoolean(this.portrait);
        s.writeBoolean(this.touchMoveActive);
        if (this.touchMoveActive) {
            s.writeUnitVec(this.touchMoveDir, 8);
            s.writeUint8(this.touchMoveLen);
        }
        s.writeUnitVec(this.toMouseDir, 10);
        s.writeFloat(this.toMouseLen, 0, Constants.MouseMaxDist, 8);
        s.writeBits(this.inputs.length, 4);
        for (let t = 0; t < this.inputs.length; t++) {
            s.writeUint8(this.inputs[t]);
        }
        s.writeGameType(this.useItem);
        s.writeBits(0, 6);
    }
}

class DropItemMsg {
    constructor() {
        this.item = "";
        this.weapIdx = 0;
    }

    serialize(e) {
        e.writeGameType(this.item);
        e.writeUint8(this.weapIdx);
        e.writeBits(0, 6);
    }
}

class PerkModeRoleSelectMsg {
    constructor() {
        this.role = "";
    }

    serialize(e) {
        e.writeGameType(this.role);
        e.writeBits(0, 6);
    }
}

class EmoteMsg {
    constructor() {
        this.pos = v2.create(0, 0);
        this.type = "";
        this.isPing = false;
    }

    serialize(e) {
        e.writeVec(this.pos, 0, 0, 1024, 1024, 16);
        e.writeGameType(this.type);
        e.writeBoolean(this.isPing);
        e.writeBits(0, 5);
    }
}

class JoinedMsg {
    constructor() {
        this.teamMode = 0;
        this.playerId = 0;
        this.started = false;
        this.emotes = [];
    }

    deserialize(e) {
        this.teamMode = e.readUint8();
        this.playerId = e.readUint16();
        this.started = e.readBoolean();
        for (let t = e.readUint8(), r = 0; r < t; r++) {
            const a = e.readGameType();
            this.emotes.push(a);
        }
        e.readAlignToNextByte();
    }
}

class MapMsg {
    constructor() {
        this.mapName = "";
        this.seed = 0;
        this.width = 0;
        this.height = 0;
        this.shoreInset = 0;
        this.grassInset = 0;
        this.rivers = [];
        this.places = [];
        this.objects = [];
        this.groundPatches = [];
    }

    deserialize(e) {
        this.mapName = e.readString(Constants.MapNameMaxLen);
        this.seed = e.readUint32();
        this.width = e.readUint16();
        this.height = e.readUint16();
        this.shoreInset = e.readUint16();
        this.grassInset = e.readUint16();
        for (let t = e.readUint8(), r = 0; r < t; r++) {
            const a = {};
            deserializeMapRiver(e, a);
            this.rivers.push(a);
        }
        for (let i = e.readUint8(), o = 0; o < i; o++) {
            const s = {};
            deserializeMapPlaces(e, s);
            this.places.push(s);
        }
        for (let n = e.readUint16(), l = 0; l < n; l++) {
            const c = {};
            deserializeMapObj(e, c);
            this.objects.push(c);
        }
        for (let m = e.readUint8(), p = 0; p < m; p++) {
            const y = {};
            deserializeMapGroundPatch(e, y);
            this.groundPatches.push(y);
        }
    }
}

const UpdateExtFlags = {
    DeletedObjects: 1 << 0,
    FullObjects: 1 << 1,
    ActivePlayerId: 1 << 2,
    Gas: 1 << 3,
    GasCircle: 1 << 4,
    PlayerInfos: 1 << 5,
    DeletePlayerIds: 1 << 6,
    PlayerStatus: 1 << 7,
    GroupStatus: 1 << 8,
    Bullets: 1 << 9,
    Explosions: 1 << 10,
    Emotes: 1 << 11,
    Planes: 1 << 12,
    AirstrikeZones: 1 << 13,
    MapIndicators: 1 << 14,
    KillLeader: 1 << 15
};

class UpdateMsg {
    constructor() {
        this.serializedObjectCache = null;
        this.objectReg = null;
        this.clientPlayer = null;
        this.activePlayer = null;
        this.grid = null;
        this.playerBarn = null;
        this.bulletBarn = null;
        this.gas = null;
        this.map = null;
        this.delObjIds = [];
        this.fullObjects = [];
        this.partObjects = [];
        this.activePlayerId = 0;
        this.activePlayerIdDirty = false;
        this.activePlayerData = {};
        this.aliveCounts = [];
        this.aliveDirty = false;
        this.gasData = {};
        this.gasDirty = false;
        this.gasT = 0;
        this.gasTDirty = false;
        this.playerInfos = [];
        this.deletedPlayerIds = [];
        this.playerStatus = {};
        this.playerStatusDirty = false;
        this.groupStatus = {};
        this.groupStatusDirty = false;
        this.bullets = [];
        this.explosions = [];
        this.emotes = [];
        this.planes = [];
        this.airstrikeZones = [];
        this.mapIndicators = [];
        this.killLeaderId = 0;
        this.killLeaderKills = 0;
        this.killLeaderDirty = false;
        this.ack = 0;
    }

    deserialize(s, objectCreator) {
        const flags = s.readUint16();

        if ((flags & UpdateExtFlags.DeletedObjects) != 0) {
            const count = s.readUint16();
            for (let i = 0; i < count; i++) {
                this.delObjIds.push(s.readUint16());
            }
        }

        if ((flags & UpdateExtFlags.FullObjects) != 0) {
            const count = s.readUint16();
            for (let i = 0; i < count; i++) {
                const data = {};
                data.__type = s.readUint8();
                data.__id = s.readUint16();
                ObjectSerializeFns[data.__type].deserializePart(s, data);
                ObjectSerializeFns[data.__type].deserializeFull(s, data);
                this.fullObjects.push(data);
            }
        }

        for (let count = s.readUint16(), i = 0; i < count; i++) {
            const data = {};
            data.__id = s.readUint16();
            const type = objectCreator.getTypeById(data.__id, s);
            ObjectSerializeFns[type].deserializePart(s, data);
            this.partObjects.push(data);
        }

        if ((flags & UpdateExtFlags.ActivePlayerId) != 0) {
            this.activePlayerId = s.readUint16();
            this.activePlayerIdDirty = true;
        }

        const activePlayerData = {};
        deserializeActivePlayer(s, activePlayerData);
        this.activePlayerData = activePlayerData;

        if ((flags & UpdateExtFlags.Gas) != 0) {
            const f = {};
            deserializeGasData(s, f);
            this.gasData = f;
            this.gasDirty = true;
        }

        if ((flags & UpdateExtFlags.GasCircle) != 0) {
            this.gasT = s.readFloat(0, 1, 16);
            this.gasTDirty = true;
        }

        if ((flags & UpdateExtFlags.PlayerInfos) != 0) {
            for (let i = s.readUint8(), b = 0; b < i; b++) {
                const x = {};
                deserializePlayerInfos(s, x);
                this.playerInfos.push(x);
            }
        }

        if ((flags & UpdateExtFlags.DeletePlayerIds) != 0) {
            for (let count = s.readUint8(), i = 0; i < count; i++) {
                const id = s.readUint16();
                this.deletedPlayerIds.push(id);
            }
        }

        if ((flags & UpdateExtFlags.PlayerStatus) != 0) {
            const playerStatus = {};
            deserializePlayerStatus(s, playerStatus);
            this.playerStatus = playerStatus;
            this.playerStatusDirty = true;
        }

        if ((flags & UpdateExtFlags.GroupStatus) != 0) {
            const groupStatus = {};
            deserializeGroupStatus(s, groupStatus);
            this.groupStatus = groupStatus;
            this.groupStatusDirty = true;
        }

        if ((flags & UpdateExtFlags.Bullets) != 0) {
            for (let count = s.readUint8(), i = 0; i < count; i++) {
                const bullet = {};
                bullet.playerId = s.readUint16();
                bullet.pos = s.readVec(0, 0, 1024, 1024, 16);
                bullet.dir = s.readUnitVec(8);
                bullet.bulletType = s.readGameType();
                bullet.layer = s.readBits(2);
                bullet.varianceT = s.readFloat(0, 1, 4);
                bullet.distAdjIdx = s.readBits(4);
                bullet.clipDistance = s.readBoolean();
                if (bullet.clipDistance) {
                    bullet.distance = s.readFloat(0, 1024, 16);
                }
                bullet.shotFx = s.readBoolean();
                if (bullet.shotFx) {
                    bullet.shotSourceType = s.readGameType();
                    bullet.shotOffhand = s.readBoolean();
                    bullet.lastShot = s.readBoolean();
                }
                bullet.reflectCount = 0;
                bullet.reflectObjId = 0;
                if (s.readBoolean()) {
                    bullet.reflectCount = s.readBits(2);
                    bullet.reflectObjId = s.readUint16();
                }
                bullet.hasSpecialFx = s.readBoolean();
                if (bullet.hasSpecialFx) {
                    bullet.shotAlt = s.readBoolean();
                    bullet.splinter = s.readBoolean();
                    bullet.trailSaturated = s.readBoolean();
                    bullet.trailSmall = s.readBoolean();
                    bullet.trailThick = s.readBoolean();
                }
                this.bullets.push(bullet);
            }
            s.readAlignToNextByte();
        }

        if ((flags & UpdateExtFlags.Explosions) != 0) {
            const count = s.readUint8();
            for (let i = 0; i < count; i++) {
                const explosion = {};
                explosion.pos = s.readVec(0, 0, 1024, 1024, 16);
                explosion.type = s.readGameType();
                explosion.layer = s.readBits(2);
                s.readAlignToNextByte();
                this.explosions.push(explosion);
            }
        }

        if ((flags & UpdateExtFlags.Emotes) != 0) {
            for (let count = s.readUint8(), i = 0; i < count; i++) {
                const emote = {};
                emote.playerId = s.readUint16();
                emote.type = s.readGameType();
                emote.itemType = s.readGameType();
                emote.isPing = s.readBoolean();
                if (emote.isPing) {
                    emote.pos = s.readVec(0, 0, 1024, 1024, 16);
                }
                s.readBits(3);
                this.emotes.push(emote);
            }
        }

        if ((flags & UpdateExtFlags.Planes) != 0) {
            for (let count = s.readUint8(), i = 0; i < count; i++) {
                const plane = {};
                plane.id = s.readUint8();
                const V = s.readVec(0, 0, 2048, 2048, 10);
                plane.pos = v2.create(V.x - 512, V.y - 512);
                plane.planeDir = s.readUnitVec(8);
                plane.actionComplete = s.readBoolean();
                plane.action = s.readBits(3);
                this.planes.push(plane);
            }
        }

        if ((flags & UpdateExtFlags.AirstrikeZones) != 0) {
            for (let count = s.readUint8(), i = 0; i < count; i++) {
                const airStrikeZone = {};
                airStrikeZone.pos = s.readVec(0, 0, 1024, 1024, 12);
                airStrikeZone.rad = s.readFloat(
                    0,
                    Constants.AirstrikeZoneMaxRad,
                    8
                );
                airStrikeZone.duration = s.readFloat(
                    0,
                    Constants.AirstrikeZoneMaxDuration,
                    8
                );
                this.airstrikeZones.push(airStrikeZone);
            }
        }

        if ((flags & UpdateExtFlags.MapIndicators) != 0) {
            for (let count = s.readUint8(), i = 0; i < count; i++) {
                const mapIndicator = {};
                mapIndicator.id = s.readBits(4);
                mapIndicator.dead = s.readBoolean();
                mapIndicator.equipped = s.readBoolean();
                mapIndicator.type = s.readGameType();
                mapIndicator.pos = s.readVec(0, 0, 1024, 1024, 16);
                this.mapIndicators.push(mapIndicator);
            }
            s.readAlignToNextByte();
        }

        if ((flags & UpdateExtFlags.KillLeader) != 0) {
            this.killLeaderId = s.readUint16();
            this.killLeaderKills = s.readUint8();
            this.killLeaderDirty = true;
        }
        this.ack = s.readUint8();
    }
}

class KillMsg {
    constructor() {
        this.itemSourceType = "";
        this.mapSourceType = "";
        this.damageType = 0;
        this.targetId = 0;
        this.killerId = 0;
        this.killCreditId = 0;
        this.killerKills = 0;
        this.downed = false;
        this.killed = false;
    }

    deserialize(e) {
        this.damageType = e.readUint8();
        this.itemSourceType = e.readGameType();
        this.mapSourceType = e.readMapType();
        this.targetId = e.readUint16();
        this.killerId = e.readUint16();
        this.killCreditId = e.readUint16();
        this.killerKills = e.readUint8();
        this.downed = e.readBoolean();
        this.killed = e.readBoolean();
        e.readAlignToNextByte();
    }
}

class PlayerStatsMsg {
    constructor() {
        this.playerId = 0;
        this.playerStats = {};
    }

    deserialize(e) {
        const t = {};
        t.playerId = e.readUint16();
        t.timeAlive = e.readUint16();
        t.kills = e.readUint8();
        t.dead = e.readUint8();
        t.damageDealt = e.readUint16();
        t.damageTaken = e.readUint16();
        this.playerStats = t;
    }
}

class GameOverMsg {
    constructor() {
        this.teamId = 0;
        this.teamRank = 0;
        this.gameOver = false;
        this.winningTeamId = 0;
        this.playerStats = [];
    }

    deserialize(e) {
        this.teamId = e.readUint8();
        this.teamRank = e.readUint8();
        this.gameOver = e.readUint8();
        this.winningTeamId = e.readUint8();
        for (let t = e.readUint8(), r = 0; r < t; r++) {
            const a = new PlayerStatsMsg();
            a.deserialize(e);
            this.playerStats.push(a.playerStats);
        }
    }
}

const PickupMsgType = {
    Full: 0,
    AlreadyOwned: 1,
    AlreadyEquipped: 2,
    BetterItemEquipped: 3,
    Success: 4,
    GunCannotFire: 5
};

class PickupMsg {
    constructor() {
        this.type = 0;
        this.item = "";
        this.count = 0;
    }

    deserialize(e) {
        this.type = e.readUint8();
        this.item = e.readGameType();
        this.count = e.readUint8();
        e.readBits(6);
    }
}

class SpectateMsg {
    constructor() {
        this.specBegin = false;
        this.specNext = false;
        this.specPrev = false;
        this.specForce = false;
    }

    serialize(e) {
        e.writeBoolean(this.specBegin);
        e.writeBoolean(this.specNext);
        e.writeBoolean(this.specPrev);
        e.writeBoolean(this.specForce);
        e.writeBits(0, 4);
    }
}

class RoleAnnouncementMsg {
    constructor() {
        this.playerId = 0;
        this.killerId = 0;
        this.role = "";
        this.assigned = false;
        this.killed = false;
    }

    deserialize(e) {
        this.playerId = e.readUint16();
        this.killerId = e.readUint16();
        this.role = e.readGameType();
        this.assigned = e.readBoolean();
        this.killed = e.readBoolean();
        e.readAlignToNextByte();
    }
}

class LoadoutMsg {
    constructor() {
        this.emotes = [];
        this.custom = false;
    }

    serialize(e) {
        for (let t = 0; t < GameConfig.EmoteSlot.Count; t++) {
            e.writeGameType(this.emotes[t]);
        }
        e.writeUint8(this.custom);
        e.writeAlignToNextByte();
    }
}

class StatsMsg {
    constructor() {
        this.data = "";
    }

    serialize(e) {
        e.writeString(this.data);
    }

    deserialize(e) {
        this.data = e.readString();
    }
}

class AliveCountsMsg {
    constructor() {
        this.teamAliveCounts = [];
    }

    serialize(e) {
        const t = this.teamAliveCounts.length;
        e.writeUint8(t);
        for (let r = 0; r < t; r++) {
            e.writeUint8(this.teamAliveCounts[r]);
        }
    }

    deserialize(e) {
        for (let t = e.readUint8(), r = 0; r < t; r++) {
            const a = e.readUint8();
            this.teamAliveCounts.push(a);
        }
    }
}

class UpdatePassMsg {
    serialize(_e) { }
    deserialize(_e) { }
}

export default {
    BitStream: bb.BitStream,
    Constants,
    getPlayerStatusUpdateRate,
    MsgStream,
    Msg: MsgType,
    JoinMsg,
    DisconnectMsg,
    InputMsg,
    DropItemMsg,
    JoinedMsg,
    UpdateMsg,
    MapMsg,
    KillMsg,
    PlayerStatsMsg,
    GameOverMsg,
    PickupMsgType,
    PickupMsg,
    SpectateMsg,
    PerkModeRoleSelectMsg,
    EmoteMsg,
    RoleAnnouncementMsg,
    LoadoutMsg,
    StatsMsg,
    UpdatePassMsg,
    AliveCountsMsg
};
