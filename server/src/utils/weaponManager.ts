import { GameObjectDefs } from "../../../shared/defs/gameObjectDefs";
import { type GunDef, type MeleeDef } from "../../../shared/defs/objectsTypings";
import { GameConfig } from "../../../shared/gameConfig";
import { type BulletParams } from "../objects/bullet";
import { ObjectType, type GameObject } from "../objects/gameObject";
import { type Obstacle } from "../objects/obstacle";
import { type Player } from "../objects/player";
import { coldet } from "../../../shared/utils/coldet";
import { collider } from "../../../shared/utils/collider";
import { collisionHelpers } from "../../../shared/utils/collisionHelpers";
import { math } from "../../../shared/utils/math";
import { util } from "../../../shared/utils/util";
import { type Vec2, v2 } from "../../../shared/utils/v2";
import net from "../../../shared/net";

export class WeaponManager {
    player: Player;

    curWeapIdx = 2;

    weapons: Array<{
        type: string
        ammo: number
        cooldown: number
    }> = [];

    get activeWeapon(): string {
        return this.weapons[this.curWeapIdx].type;
    }

    meleeCooldown = 0;

    timeouts: NodeJS.Timeout[] = [];

    constructor(player: Player) {
        this.player = player;

        for (let i = 0; i < GameConfig.WeaponSlot.Count; i++) {
            this.weapons.push({
                type: GameConfig.WeaponType[i] === "melee" ? "fists" : "",
                ammo: 0,
                cooldown: 0
            });
        }
        this.weapons[0].type = "m870";
        this.weapons[1].type = "spas12";
        this.weapons[0].ammo = 30;
        this.weapons[1].ammo = 30;
    }

    shootStart(): void {
        const def = GameObjectDefs[this.activeWeapon];

        if (def) {
            switch (def.type) {
            case "melee": {
                if (this.player.game.now > this.meleeCooldown) {
                    this.meleeAttack();
                }
                break;
            }
            case "gun": {
                if (this.weapons[this.curWeapIdx].ammo != 0) {
                    this.fireWeapon(false, this.activeWeapon);
                }
                break;
            }
            }
        }
    }

    shootHold(): void {
        this.shootStart();
    }

    reload() {
        if (this.player.actionType == GameConfig.Action.Reload) {
            return;
        }
        const weaponInfo = GameObjectDefs[this.activeWeapon] as GunDef;
        const conditions = [
            this.player.actionType == (GameConfig.Action.UseItem as number),
            this.weapons[this.curWeapIdx].ammo >= weaponInfo.maxClip,
            this.player.inventory[weaponInfo.ammo] == 0,
            this.curWeapIdx == 2 || this.curWeapIdx == 3
        ];
        if (conditions.some(c => c)) {
            return;
        }

        const duration = weaponInfo.reloadTime;

        this.player.doAction(this.activeWeapon, GameConfig.Action.Reload, duration);
    }

    // TODO: proper firing delays and stuff
    fireDelay = 0;
    fireWeapon(offhand: boolean, type: string) {
        // if (this.fireDelay > this.player.game.now) return;
        if (this.weapons[this.curWeapIdx].cooldown > this.player.game.now) return;
        const itemDef = GameObjectDefs[type] as GunDef;

        this.weapons[this.curWeapIdx].cooldown = this.player.game.now + (itemDef.fireDelay * 1000);
        // this.fireDelay = this.player.game.now + (itemDef.fireDelay * 1000);

        // Check firing location
        if (itemDef.outsideOnly && this.player.indoors) {
            const msg = new net.PickupMsg();
            msg.type = net.PickupMsgType.GunCannotFire;
            this.player.msgsToSend.push({ type: net.MsgType.Pickup, msg });
            return;
        }

        const direction = this.player.dir;
        const toMouseLen = this.player.toMouseLen;

        this.player.cancelAction(false);

        this.weapons[this.curWeapIdx].ammo--;
        this.player.dirty.weapons = true;

        const collisionLayer = util.toGroundLayer(this.player.layer);
        const bulletLayer = this.player.aimLayer;

        const gunOff = itemDef.isDual ? itemDef.dualOffset! * (offhand ? 1.0 : -1.0) : itemDef.barrelOffset;
        const gunPos = v2.add(this.player.pos, v2.mul(v2.perp(direction), gunOff));
        const gunLen = itemDef.barrelLength;

        // Compute gun pos clipping if there is an obstacle in the way
        // @NOTE: Add an extra 1.5 to account for shotgun shots being
        //        offset to spawn infront of the gun
        let clipLen = gunLen + 1.5;
        let clipPt = v2.add(gunPos, v2.mul(direction, clipLen));
        let clipNrm = v2.mul(direction, -1.0);
        const aabb = collider.createAabbExtents(this.player.pos, v2.create(this.player.rad + gunLen + 1.5));

        const nearbyObjs = this.player.game.grid.intersectCollider(aabb).filter(obj => obj.__type === ObjectType.Obstacle) as Obstacle[];

        for (let i = 0; i < nearbyObjs.length; i++) {
            const obj = nearbyObjs[i];

            // eslint-disable-next-line no-mixed-operators
            if (obj.dead || !obj.collidable && obj.isWall || !util.sameLayer(obj.layer, bulletLayer) || obj.height < GameConfig.bullet.height) {
                continue;
            }
            // @NOTE: The player can sometimes be inside a collider.
            // This can happen when the bulletLayer is different from
            // the player's layer, ie when the player is firing down a
            // stairwell. In this case we'll just ignore that particular
            // collider.
            // Create fake circle for detecting collision between guns and map objects.
            if (!util.sameLayer(collisionLayer, bulletLayer) && collider.intersectCircle(obj.collider, gunPos, GameConfig.player.radius)) {
                continue;
            }

            const res = collider.intersectSegment(obj.collider, gunPos, clipPt);
            if (res) {
                const colPos = v2.add(res.point, v2.mul(res.normal, 0.01));
                const newLen = v2.length(v2.sub(colPos, gunPos));
                if (newLen < clipLen) {
                    clipLen = newLen;
                    clipPt = colPos;
                    clipNrm = res.normal;
                }
            }
        }

        const hasExplosive = this.player.hasPerk("explosive");
        const hasSplinter = this.player.hasPerk("splinter");

        // Movement spread
        let spread = itemDef.shotSpread ?? 0;
        const travel = v2.sub(this.player.pos, this.player.posOld);
        if (v2.length(travel) > 0.01) {
            spread += itemDef.moveSpread ?? 0;
        }

        // Recoil currently just cancels spread if you shoot slow enough.
        if (this.player.recoilTicker >= itemDef.recoilTime) {
            spread = 0.0;
        }
        this.player.recoilTicker = 0.0;

        const bulletCount = itemDef.bulletCount;
        const jitter = itemDef.jitter ?? 0.25;

        for (let i = 0; i < bulletCount; i++) {
            const deviation = util.random(-0.5, 0.5) * (spread || 0);
            const shotDir = v2.rotate(direction, math.deg2rad(deviation));

            // Compute shot start position
            let bltStart = v2.add(gunPos, v2.mul(direction, gunLen));
            if (i > 0) {
                // Add shotgun jitter
                const offset = v2.mul(v2.create(util.random(-jitter, jitter), util.random(-jitter, jitter)), 1.11);
                bltStart = v2.add(bltStart, offset);
            }

            let toBlt = v2.sub(bltStart, gunPos);
            let toBltLen = v2.length(toBlt);
            toBlt = toBltLen > 0.00001 ? v2.div(toBlt, toBltLen) : v2.create(1.0, 0.0);
            // Clip with nearly obstacle plane
            // @TODO: This doesn't handle interior corners properly;
            //        bullets may still escape if one spawns closer
            //        to a different clipping plane than the gun end.
            const dn = v2.dot(toBlt, clipNrm);
            if (dn < -0.00001) {
                const t = v2.dot(v2.sub(clipPt, gunPos), clipNrm) / dn;
                if (t < toBltLen) {
                    toBltLen = t - 0.1;
                }
            }
            const shotPos = v2.add(gunPos, v2.mul(toBlt, toBltLen));
            let maxDistance = Number.MAX_VALUE;
            if (itemDef.toMouseHit) {
                maxDistance = math.max(toMouseLen - gunLen, 0.0);
            }
            const damageMult = 1.0;

            const params: BulletParams = {
                playerId: this.player.id,
                bulletType: itemDef.bulletType,
                sourceType: type,
                damageType: GameConfig.DamageType.Player,
                pos: shotPos,
                dir: shotDir,
                layer: bulletLayer,
                maxDistance,
                variance: 1,
                damageMult,
                shotFx: i === 0,
                shotOffhand: offhand,
                trailSmall: false,
                reflectCount: 0,
                splinter: hasSplinter,
                // reflectObjId: this.player.linkedObstacleId,
                onHitFx: hasExplosive ? "explosion_rounds" : undefined
            };
            this.player.game.bulletManager.fireBullet(params);

            // Shoot a projectile if defined
            if (itemDef.projType) {
                // const projDef = GameObjectDefs[itemDef.projType];
                // assert(projDef && projDef.type === 'throwable');
                // const vel = v2.mul(shotDir, projDef.throwPhysics.speed);
                // this.projectileBarn.addProjectile(this.player.__id, itemDef.projType, shotPos, 0.5, bulletLayer, vel, projDef.fuseTime, GameConfig.DamageType.Player);
            }

            // Splinter creates additional bullets that deviate on either side of
            // the main bullet
            const splinterSpread = math.max(spread, 1.0);
            if (hasSplinter && !itemDef.noSplinter) {
                for (let j = 0; j < 2; j++) {
                    const sParams = { ...params };

                    const _deviation = util.random(0.2, 0.25) * splinterSpread * (j % 2 === 0 ? -1.0 : 1.0);
                    sParams.dir = v2.rotate(sParams.dir, math.deg2rad(_deviation));
                    sParams.lastShot = false;
                    sParams.shotFx = false;
                    sParams.trailSmall = true;
                    sParams.damageMult *= 0.45;

                    this.player.game.bulletManager.fireBullet(sParams);
                }
            }
        }
        if (this.weapons[this.curWeapIdx].ammo == 0) {
            this.player.scheduleAction(this.activeWeapon, GameConfig.Action.Reload);
        }
    }

    getMeleeCollider() {
        const meleeDef = GameObjectDefs[this.player.activeWeapon] as MeleeDef;
        const rot = Math.atan2(this.player.dir.y, this.player.dir.x);

        const pos = v2.add(
            meleeDef.attack.offset,
            v2.mul(v2.create(1, 0), this.player.scale - 1)
        );
        const rotated = v2.add(this.player.pos, v2.rotate(pos, rot));
        const rad = meleeDef.attack.rad;
        return collider.createCircle(rotated, rad, 0);
    }

    meleeAttack(): void {
        const meleeDef = GameObjectDefs[this.player.activeWeapon] as MeleeDef;

        this.player.animType = GameConfig.Anim.Melee;
        this.meleeCooldown = this.player.game.now + (meleeDef.attack.cooldownTime * 1000);

        this.timeouts.push(setTimeout(() => {
            this.player.animType = GameConfig.Anim.None;
        }, meleeDef.attack.cooldownTime * 1000));

        const damageTimes = meleeDef.attack.damageTimes;
        for (let i = 0; i < damageTimes.length; i++) {
            const damageTime = damageTimes[i];
            this.timeouts.push(setTimeout(() => {
                this.meleeDamage();
            }, damageTime * 1000));
        }
    }

    meleeDamage(): void {
        const meleeDef = GameObjectDefs[this.activeWeapon];

        if (meleeDef === undefined || meleeDef.type !== "melee" || this.player.dead) {
            return;
        }

        const coll = this.getMeleeCollider();
        const lineEnd = coll.rad + v2.length(v2.sub(this.player.pos, coll.pos));

        const hits: Array<{
            obj: GameObject
            prio: number
            pos: Vec2
            pen: number
        }> = [];

        const objs = this.player.game.grid.intersectCollider(coll);

        const obstacles = objs.filter(obj => obj.__type === ObjectType.Obstacle) as Obstacle[];

        for (const obj of objs) {
            if (obj.__type === ObjectType.Obstacle) {
                const obstacle = obj;
                if (!(obstacle.dead ||
                    obstacle.isSkin ||
                    obstacle.height < GameConfig.player.meleeHeight) &&
                    util.sameLayer(obstacle.layer, 1 & this.player.layer)) {
                    let collision = collider.intersectCircle(
                        obstacle.collider,
                        coll.pos,
                        coll.rad
                    );

                    if (meleeDef.cleave) {
                        const normalized = v2.normalizeSafe(
                            v2.sub(obstacle.pos, this.player.pos),
                            v2.create(1, 0)
                        );
                        const intersectedObstacle = collisionHelpers.intersectSegment(
                            obstacles,
                            this.player.pos,
                            normalized,
                            lineEnd,
                            1,
                            this.player.layer,
                            false
                        );
                        intersectedObstacle && intersectedObstacle.id !== obstacle.id && (collision = null);
                    }
                    if (collision) {
                        const pos = v2.add(
                            coll.pos,
                            v2.mul(
                                v2.neg(collision.dir),
                                coll.rad - collision.pen
                            )
                        );
                        hits.push({
                            obj: obstacle,
                            pen: collision.pen,
                            prio: 1,
                            pos
                        });
                    }
                }
            } else if (obj.__type === ObjectType.Player) {
                const player = obj;
                if (player.id !== this.player.id &&
                    !player.dead &&
                    util.sameLayer(player.layer, this.player.layer)
                ) {
                    const normalized = v2.normalizeSafe(
                        v2.sub(player.pos, this.player.pos),
                        v2.create(1, 0)
                    );
                    const collision = coldet.intersectCircleCircle(
                        coll.pos,
                        coll.rad,
                        player.pos,
                        player.rad
                    );
                    if (collision &&
                        math.eqAbs(
                            lineEnd,
                            collisionHelpers.intersectSegmentDist(
                                obstacles,
                                this.player.pos,
                                normalized,
                                lineEnd,
                                GameConfig.player.meleeHeight,
                                this.player.layer,
                                false
                            )
                        )
                    ) {
                        hits.push({
                            obj: player,
                            pen: collision.pen,
                            prio: player.teamId === this.player.teamId ? 2 : 0,
                            pos: v2.copy(player.pos)
                        });
                    }
                }
            }
        }

        hits.sort((a, b) => {
            return a.prio === b.prio
                ? b.pen - a.pen
                : a.prio - b.prio;
        });

        let maxHits = hits.length;
        if (!meleeDef.cleave) maxHits = math.min(maxHits, 1);

        for (let i = 0; i < maxHits; i++) {
            const hit = hits[i];
            const obj = hit.obj;

            if (obj.__type === ObjectType.Obstacle) {
                obj.damage(meleeDef.damage * meleeDef.obstacleDamage, this.activeWeapon, GameConfig.DamageType.Player);
                if (obj.interactable) obj.interact(this.player);
            } else if (obj.__type === ObjectType.Player) {
                obj.damage(meleeDef.damage, this.activeWeapon, GameConfig.DamageType.Player, this.player);
            }
        }
    }
}
