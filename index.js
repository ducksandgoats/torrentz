import WebTorrent from "webtorrent";
import fs from "fs-extra";
import path from "path";
import ed from "ed25519-supercop";
import bencode from "bencode";
import { pipelinePromise, Readable } from "streamx";
import createTorrent from "create-torrent";
import parseTorrent from "parse-torrent";
import wrtc from "wrtc";
import { uid } from "uid";
import glob from "glob";
import { Level } from "level";
import crypto from "crypto";
import ut_msg from "ut_msg";
import {EventEmitter} from 'events'

// saves us from saving secret keys(saving secret keys even encrypted secret keys is something i want to avoid)
// with this function which was taken from the bittorrent-dht package
// we save only the signatures when we first publish a BEP46 torrent

export default class Torrentz extends EventEmitter {
  constructor (opts = {}) {
    super()
    const defOpts = { dir: import.meta.dirname, storage: 'storage', base: 'base', routine: 3600000, dht: { verify: (sig, message, key) => {return ed.verify(sig, ArrayBuffer.isView(message) ? Buffer.from(message.buffer, message.byteOffset, message.byteLength) : message, key)} } }
    const finalOpts = { ...defOpts, ...opts }
    this._routine = finalOpts.routine
    this.checkHash = /^[a-fA-F0-9]{40}$/
    this.checkAddress = /^[a-fA-F0-9]{64}$/

    finalOpts.dir = path.resolve(finalOpts.dir)
    this._storage = path.join(finalOpts.dir, finalOpts.storage)
    this._base = path.join(finalOpts.dir, finalOpts.base)
    fs.ensureDirSync(this._storage)
    fs.ensureDirSync(this._base)

    // this.webtorrent = finalOpts.webtorrent ? finalOpts.webtorrent : new WebTorrent({ dht: { verify: ed.verify }, tracker: {wrtc} })
    this.db = finalOpts.leveldb || new Level(this._base, { valueEncoding: 'json' })
    this.webtorrent = finalOpts.webtorrent || new WebTorrent({ ...finalOpts })
    // this.webtorrent = new WebTorrent({ ...finalOpts, dht: { verify: ed.verify } })

    globalThis.WEBTORRENT_ANNOUNCE = createTorrent.announceList.map(arr => arr[0]).filter(url => url.indexOf('wss://') === 0 || url.indexOf('ws://') === 0)
    globalThis.WRTC = wrtc
    
    this.webtorrent.on('error', error => {
      this.emit('err', error)
    })

    this.checkId = new Map()
    this._readyToGo = true
    this._fixed = {BTPK_PREFIX: 'urn:btpk:', seed: 'seed-', load: 'load-', address: 'address-', infohash: 'infohash-', msg: 'msg-'}

    // run the start up function
    // this.startUp().catch(error => { console.error(error) })

    // run the keepUpdated function every 1 hour, it keep the data active by putting the data back into the dht, don't run it if it is still working from the last time it ran the keepUpdated function
    this.session = setInterval(() => {
      if (this._readyToGo) {
        this.keepUpdated().then(data => console.log('amount of torrents:', data)).catch(error => console.error('routine update had a reject', error))
      }
    }, this._routine)
  }

  encodeSigData (msg) {
    const ref = { seq: msg.seq, v: msg.v }
    if(msg.salt){
      ref.salt = msg.salt
    }
    const benc = bencode.encode(ref).slice(1, -1)
    return Buffer.from(benc.buffer, benc.byteOffset, benc.byteLength)
  }

  // keep data active in the dht, runs every hour
  async keepUpdated () {
    this._readyToGo = false
    for (const torrent of this.webtorrent.torrents) {
      if (torrent.record) {
        try {
          await this.saveData(torrent.record)
        } catch (err) {
          console.error(torrent.record.address, err)
        }
        await new Promise((resolve, reject) => setTimeout(resolve, 3000))
      }
    }
    this._readyToGo = true
    return this.webtorrent.torrents.length
  }

  async resOrRej(res, rej){
    try {
      return await res
    } catch (error) {
      if (rej) {
        if(rej !== true){
          await rej()
        }
        // if (useCaught.cb) {
        //   await useCaught.cb()
        // }
        throw error
      } else {
        return rej
      }
    }
  }

  // async handleTheData(useTimeOut, waitForData, useCaught) {
  //   try {
  //     if (useTimeOut.num) {
  //       return await Promise.race([
  //         new Promise((resolve, reject) => { setTimeout(() => { if (useTimeOut.res) { resolve(`${useTimeOut.id} took too long, it timed out - ${useTimeOut.kind}`) } else { const err = new Error(`${useTimeOut.id} took too long, it timed out - ${useTimeOut.kind}`); err.name = 'ErrorTimeout'; reject(err); } }, useTimeOut.num) }),
  //         waitForData
  //       ])
  //     } else {
  //       return await waitForData
  //     }
  //   } catch (error) {
  //     if (useCaught.err) {
  //       if (useCaught.cb) {
  //         await useCaught.cb()
  //       }
  //       throw error
  //     } else {
  //       return useCaught.cb ? await useCaught.cb() : useCaught.cb
  //     }
  //   }
  // }

  // when we resume or seed a user created BEP46 torrent that has already been created before
  // we have to check that the infohash of the torrent(remember we do not know the infohash before) matches the signature
  // if it does not match, that means the data/torrent has been corrupted somehow
  async ownData (data, infoHash) {
    const hashBuff = Buffer.from(infoHash, 'hex')
    const signatureBuff = Buffer.from(data.sig, 'hex')
    const stuffBuff = this.stuffToBuf(data.stuff)
    const encodedSignatureData = this.encodeSigData({ seq: data.sequence, v: { ih: hashBuff, ...stuffBuff } })
    const addressBuff = Buffer.from(data.address, 'hex')

    if (!ed.verify(signatureBuff, encodedSignatureData, addressBuff)) {
      throw new Error('data does not match signature')
    }

    const putData = await new Promise((resolve, reject) => {
      this.webtorrent.dht.put({ k: addressBuff, v: {ih: hashBuff, ...stuffBuff}, seq: data.sequence, sig: signatureBuff }, (putErr, hash, number) => {
        if (putErr) {
          reject(putErr)
        } else {
          resolve({ hash: hash.toString('hex'), number })
        }
      })
    })

    return {...data, ...putData}
  }

  // resolve public key address to an infohash
  async resolveFunc (address) {
    if (!address || typeof (address) !== 'string') {
      throw new Error('address can not be parsed')
    }
    const getData = await new Promise((resolve, reject) => {
      this.webtorrent.dht.get(crypto.createHash('sha1').update(Buffer.from(address, 'hex')).digest('hex'), (err, res) => {
        if (err) {
          reject(err)
        } else if (res) {
          resolve(res)
        } else if (!res) {
          reject(new Error('Could not resolve address'))
        }
      })
    })

    getData.v.ih = getData.v.ih.toString('hex')

    const { ih, ...stuff } = getData.v
    
    for (const prop in stuff) {
      stuff[prop] = stuff[prop].toString('utf-8')
    }

    if (!this.checkHash.test(ih)) {
      throw new Error('data is invalid')
    }

    return { magnet: `magnet:?xs=${this._fixed.BTPK_PREFIX}${address}`, address, infohash: ih, sequence: getData.seq, stuff, sig: getData.sig.toString('hex'), from: getData.id.toString('hex') }
  }

  // publish an infohash under a public key address in the dht
  async publishFunc (address, secret, text, count) {
    for (const prop in text) {
      if (typeof (text[prop]) !== 'string') {
        throw new Error('text data must be strings')
      }
    }
    if (!this.checkHash.test(text.ih)) {
      throw new Error('must have infohash')
    }
    if (!address || !secret) {
      throw new Error('must have address and secret')
    }

    const buffAddKey = Buffer.from(address, 'hex')
    const buffSecKey = secret ? Buffer.from(secret, 'hex') : null
    const v = {}

    for(const prop in text){
      if(prop === 'ih'){
        v[prop] = Buffer.from(text[prop], 'hex')
      } else {
        v[prop] = Buffer.from(text[prop], 'utf-8')
      }
    }

    let seq = count

    const buffSig = ed.sign(this.encodeSigData({ seq, v }), buffAddKey, buffSecKey)

    const putData = await new Promise((resolve, reject) => {
      this.webtorrent.dht.put({ k: buffAddKey, v, seq, sig: buffSig }, (putErr, hash, number) => {
        if (putErr) {
          reject(putErr)
        } else {
          resolve({ hash: hash.toString('hex'), number })
        }
      })
    })
    const { ih, ...stuff } = text
    return { magnet: `magnet:?xs=${this._fixed.BTPK_PREFIX}${address}`, address, infohash: ih, sequence: seq, stuff, sig: buffSig.toString('hex'), ...putData }
  }

  // checkSaveSend(id, pathToData, torrent){
  //   if(torrent){
  //     this.checkId.set(id, torrent)
  //     if (path.extname(pathToData)) {
  //       return {complete: torrent.complete, done: torrent.done, progress: torrent.progress, remain: `${torrent.downloaded} out of ${torrent.length}`, data: torrent.files.find(file => { return pathToData === file.urlPath })}
  //     } else {
  //       return {complete: torrent.complete, done: torrent.done, progress: torrent.progress, remain: `${torrent.downloaded} out of ${torrent.length}`, data: torrent.files.filter(file => {return file.urlPath.startsWith(pathToData)})}
  //     }
  //   } else {
  //     const hasIt = this.checkId.has(id)
  //     const mainData = hasIt ? this.checkId.get(id) : this.findTheTorrent(id)
  //     if (mainData) {
  //       if (!hasIt) {
  //         this.checkId.set(mainData.address || mainData.infohash, mainData)
  //       }
  //       if (path.extname(pathToData)) {
  //         return {complete: mainData.complete, done: mainData.done, progress: mainData.progress, remain: `${mainData.downloaded} out of ${mainData.length}`, data: mainData.files.find(file => { return pathToData === file.urlPath })}
  //       } else {
  //         return {complete: mainData.complete, done: mainData.done, progress: mainData.progress, remain: `${mainData.downloaded} out of ${mainData.length}`, data: mainData.files.filter(file => { return file.urlPath.startsWith(pathToData) })}
  //       }
  //     } else {
  //       return null
  //     }
  //   }
  // }

  async takeOutTorrent(data, opts){
    if(this.checkId.has(data)){
      this.checkId.delete(data)
    }
    const activeTorrent = this.findTheTorrent(data)
    if(activeTorrent){
      // await this.stopTorrent(activeTorrent.infoHash, {destroyStore: false})
      if(activeTorrent.msg){
        activeTorrent.emit('over')
        activeTorrent.wires.forEach((data) => {
          data.ut_msg.off('msg', activeTorrent.onData)
        })
        activeTorrent.off('wire', activeTorrent.extendTheWire)
      }
      return await new Promise((resolve, reject) => {
        activeTorrent.destroy(opts, (err) => {
          if (err) {
            reject(err)
          } else {
            resolve(data)
          }
        })
      })
    } else {
      return data
    }
  }

  async loadTorrent(id, pathToData, opts){
    if(this.checkHash.test(id)){
      const hasIt = this.checkId.has(id)
      const mainData = hasIt ? this.checkId.get(id) : this.findTheTorrent(id)
      if (mainData && mainData.complete) {
        if (!hasIt) {
          this.checkId.set(mainData.infohash, mainData)
        }
        if(mainData.done){
          if (path.extname(pathToData)) {
            return opts.torrent ? {data: mainData.files.find(file => { return pathToData === file.urlPath }), torrent: mainData} : mainData.files.find(file => { return pathToData === file.urlPath })
          } else {
            return opts.torrent ? {data: mainData.files.filter(file => { return file.urlPath.startsWith(pathToData) }), torrent: mainData} : mainData.files.filter(file => { return file.urlPath.startsWith(pathToData) })
          }
        } else {
          throw new Error('torrent is not fully downloaded yet')
        }
      } else {
        const authorStuff = await this.resOrRej(this.db.get(`${this._fixed.seed}${this._fixed.infohash}${id}`), null)
        if (authorStuff) {
          const folderPath = path.join(this._storage, authorStuff.dir)
          const checkTorrent = mainData || await this.resOrRej(this.startTorrent(folderPath, { ...authorStuff.desc, destroyStoreOnDestroy: false }), true)
          if(checkTorrent.infoHash !== authorStuff.infohash){
            await this.resOrRej(this.stopTorrent(checkTorrent.infoHash, {destroyStore: false}), true)
            // this.webtorrent.remove(checkTorrent.infoHash, { destroyStore: false })
            throw new Error('infohash does not match with the given infohash')
          }
          checkTorrent.folder = folderPath
          checkTorrent.address = null
          checkTorrent.msg = null
          checkTorrent.own = true
          checkTorrent.infohash = checkTorrent.infoHash
          checkTorrent.id = checkTorrent.infoHash
          checkTorrent.dir = authorStuff.dir
          checkTorrent.files.forEach(file => {file.urlPath = file.path.slice(checkTorrent.name.length).replace(/\\/g, '/')})
          checkTorrent.complete = true

          if(!this.checkId.has(checkTorrent.infoHash)){
            this.checkId.set(checkTorrent.infoHash, checkTorrent)
          }
          if (path.extname(pathToData)) {
            return opts.torrent ? {data: checkTorrent.files.find(file => { return pathToData === file.urlPath }), torrent: checkTorrent} : checkTorrent.files.find(file => { return pathToData === file.urlPath })
          } else {
            return opts.torrent ? {data: checkTorrent.files.filter(file => {return file.urlPath.startsWith(pathToData)}), torrent: checkTorrent} : checkTorrent.files.filter(file => {return file.urlPath.startsWith(pathToData)})
          }
        } else {
          const folderPath = path.join(this._storage, id)
          const checkTorrent = mainData || await this.resOrRej(this.midTorrent(id, { path: folderPath, destroyStoreOnDestroy: false }), true)
          checkTorrent.infohash = checkTorrent.infoHash
          checkTorrent.id = checkTorrent.infoHash
          await this.resOrRej(this.db.put(`${this._fixed.load}${this._fixed.infohash}${checkTorrent.infohash}`, {id: checkTorrent.id, size: checkTorrent.length, length: checkTorrent.files.length, infohash: checkTorrent.infohash, name: checkTorrent.name, dir: checkTorrent.dir}), true)
          checkTorrent.folder = folderPath
          checkTorrent.address = null
          checkTorrent.msg = null
          checkTorrent.own = false
          checkTorrent.dir = null
          checkTorrent.files.forEach(file => {file.urlPath = file.path.slice(checkTorrent.name.length).replace(/\\/g, '/')})
          checkTorrent.complete = true

          if(!this.checkId.has(checkTorrent.infoHash)){
            this.checkId.set(checkTorrent.infoHash, checkTorrent)
          }
          if(checkTorrent.done){
            if (path.extname(pathToData)) {
              return opts.torrent ? {data: checkTorrent.files.find(file => { return pathToData === file.urlPath }), torrent: checkTorrent} : checkTorrent.files.find(file => { return pathToData === file.urlPath })
            } else {
              return opts.torrent ? {data: checkTorrent.files.filter(file => {return file.urlPath.startsWith(pathToData)}), torrent: checkTorrent} : checkTorrent.files.filter(file => {return file.urlPath.startsWith(pathToData)})
            }
          } else {
            throw new Error('torrent is not fully downloaded yet')
          }
        }
      }
    } else if(this.checkAddress.test(id)){
      const hasIt = this.checkId.has(id)
      const mainData = hasIt ? this.checkId.get(id) : this.findTheTorrent(id)
      if (mainData && mainData.complete) {
        if (!hasIt) {
          this.checkId.set(mainData.address, mainData)
        }
        if(mainData.done){
          if (path.extname(pathToData)) {
            return opts.torrent ? {data: mainData.files.find(file => { return pathToData === file.urlPath }), torrent: mainData} : mainData.files.find(file => { return pathToData === file.urlPath })
          } else {
            return opts.torrent ? {data: mainData.files.filter(file => { return file.urlPath.startsWith(pathToData) }), torrent: mainData} : mainData.files.filter(file => { return file.urlPath.startsWith(pathToData) })
          }
        } else {
          throw new Error('torrent is not fully downloaded yet')
        }
      } else {
        const authorStuff = await this.resOrRej(this.db.get(`${this._fixed.seed}${this._fixed.address}${id}`), null)
        if(authorStuff){
          const folderPath = path.join(this._storage, authorStuff.dir)
          const checkTorrent = mainData || await this.resOrRej(this.startTorrent(folderPath, { ...authorStuff.desc, destroyStoreOnDestroy: true }), true)
          if(checkTorrent.infoHash !== authorStuff.infohash){
            await this.resOrRej(this.stopTorrent(checkTorrent.infoHash, {destroyStore: false}), true)
            // this.webtorrent.remove(checkTorrent.infoHash, { destroyStore: false })
            throw new Error('infohash does not match with the given infohash')
          }
          const checkProperty = await this.resOrRej(this.ownData(authorStuff, checkTorrent.infoHash), true)
          // don't overwrite the torrent's infohash even though they will both be the same
          checkProperty.folder = folderPath
          for (const prop in checkProperty) {
            checkTorrent[prop] = checkProperty[prop]
          }
          checkTorrent.id = checkTorrent.address
          checkTorrent.msg = null
          checkTorrent.infohash = null
          checkTorrent.dir = null
          checkTorrent.own = true
          checkTorrent.files.forEach(file => { file.urlPath = file.path.slice(checkTorrent.name.length).replace(/\\/g, '/') })
          checkTorrent.record = checkProperty
          checkTorrent.complete = true

          if(!this.checkId.has(checkTorrent.address)){
            this.checkId.set(checkTorrent.address, checkTorrent)
          }
          if (path.extname(pathToData)) {
            return opts.torrent ? {data: checkTorrent.files.find(file => { return pathToData === file.urlPath }), torrent: checkTorrent} : checkTorrent.files.find(file => { return pathToData === file.urlPath })
          } else {
            return opts.torrent ? {data: checkTorrent.files.filter(file => {return file.urlPath.startsWith(pathToData)}), torrent: checkTorrent} : checkTorrent.files.filter(file => {return file.urlPath.startsWith(pathToData)})
          }
        } else {
          const folderPath = path.join(this._storage, id)
  
          const checkProperty = await this.resOrRej(this.resolveFunc(id), true)
  
          checkProperty.folder = folderPath
          const dataPath = path.join(checkProperty.folder, checkProperty.infohash)
  
          if (!await fs.pathExists(dataPath)) {
            await fs.emptyDir(checkProperty.folder)
          }
  
          const checkTorrent = mainData || await this.resOrRej(this.midTorrent(checkProperty.infohash, { path: dataPath, destroyStoreOnDestroy: false }), true)
          // don't overwrite the torrent's infohash even though they will both be the same
          for (const prop in checkProperty) {
            checkTorrent[prop] = checkProperty[prop]
          }
          checkTorrent.id = checkTorrent.address
          checkTorrent.msg = null
          checkTorrent.infohash = null
          await this.resOrRej(this.db.put(`${this._fixed.load}${this._fixed.address}${checkTorrent.address}`, {id: checkTorrent.id, size: checkTorrent.length, length: checkTorrent.files.length, address: checkTorrent.address, infohash: checkTorrent.infohash, name: checkTorrent.name}), true)
          checkTorrent.own = false
          checkTorrent.dir = null
          checkTorrent.files.forEach(file => { file.urlPath = file.path.slice(checkTorrent.name.length).replace(/\\/g, '/') })
          checkTorrent.record = checkProperty
          checkTorrent.complete = true

          if(!this.checkId.has(checkTorrent.address)){
            this.checkId.set(checkTorrent.address, checkTorrent)
          }
          if(checkTorrent.done){
            if (path.extname(pathToData)) {
              return opts.torrent ? {data: checkTorrent.files.find(file => { return pathToData === file.urlPath }), torrent: checkTorrent} : checkTorrent.files.find(file => { return pathToData === file.urlPath })
            } else {
              return opts.torrent ? {data: checkTorrent.files.filter(file => {return file.urlPath.startsWith(pathToData)}), torrent: checkTorrent} : checkTorrent.files.filter(file => {return file.urlPath.startsWith(pathToData)})
            }
          } else {
            throw new Error('torrent is not fully downloaded yet')
          }
        }
      }
    } else {
      const hasIt = this.checkId.has(id)
      const mainData = hasIt ? this.checkId.get(id) : this.findTheTorrent(id)
      if (mainData && mainData.complete) {
        if (!hasIt) {
          this.checkId.set(mainData.msg, mainData)
        }
        if (path.extname(pathToData)) {
          return opts.torrent ? {data: mainData.files.find(file => { return pathToData === file.urlPath }), torrent: mainData} : mainData.files.find(file => { return pathToData === file.urlPath })
        } else {
          return opts.torrent ? {data: mainData.files.filter(file => { return file.urlPath.startsWith(pathToData) }), torrent: mainData} : mainData.files.filter(file => { return file.urlPath.startsWith(pathToData) })
        }
      } else {
        const authorStuff = await this.resOrRej(this.db.get(`${this._fixed.seed}${this._fixed.msg}${id}`), null)
        if (authorStuff) {
          const folderPath = path.join(this._storage, authorStuff.dir)
          const name = authorStuff.name
          const checkTorrent = mainData || await this.resOrRej(this.startTorrent(Buffer.from(authorStuff.msg), { ...authorStuff.desc, destroyStoreOnDestroy: false, path: folderPath, name }), true)
          if(authorStuff.infohash !== checkTorrent.infoHash){
            if (authorStuff.infohash) {
              await this.db.del(`${this._fixed.seed}${this._fixed.msg}${authorStuff.msg}`)
            }
            authorStuff.infohash = checkTorrent.infoHash
          }
          await this.db.put(`${this._fixed.seed}${this._fixed.msg}${authorStuff.msg}`, authorStuff)

          checkTorrent.msg = authorStuff.msg
          checkTorrent.id = checkTorrent.msg
          checkTorrent.folder = folderPath
          checkTorrent.address = null
          checkTorrent.infohash = null
          checkTorrent.own = true
          checkTorrent.infohash = checkTorrent.infoHash
          checkTorrent.dir = authorStuff.dir
          checkTorrent.files.forEach(file => {file.urlPath = file.path.slice(checkTorrent.name.length).replace(/\\/g, '/')})
          checkTorrent.complete = true

          if(!this.checkId.has(checkTorrent.msg)){
            this.checkId.set(checkTorrent.msg, checkTorrent)
          }
          if (path.extname(pathToData)) {
            return opts.torrent ? {data: checkTorrent.files.find(file => { return pathToData === file.urlPath }), torrent: checkTorrent} : checkTorrent.files.find(file => { return pathToData === file.urlPath })
          } else {
            return opts.torrent ? {data: checkTorrent.files.filter(file => {return file.urlPath.startsWith(pathToData)}), torrent: checkTorrent} : checkTorrent.files.filter(file => {return file.urlPath.startsWith(pathToData)})
          }
        } else {
          const authorStuff = {id, msg: id, infohash: null, dir: id, name: id, desc: {}}
      
          const folderPath = path.join(this._storage, authorStuff.dir)
          const name = authorStuff.name
    
          // await fs.ensureDir(folderPath)
          authorStuff.desc = opts.desc || authorStuff.desc

          const checkTorrent = mainData || await this.resOrRej(this.startTorrent(Buffer.from(authorStuff.msg), { ...authorStuff.desc, destroyStoreOnDestroy: false, path: folderPath, name }), true)
          if(authorStuff.infohash !== checkTorrent.infoHash){
            // if (authorStuff.infohash) {
            //   await this.db.del(`${this._fixed.seed}${this._fixed.msg}${authorStuff.msg}`)
            // }
            authorStuff.infohash = checkTorrent.infoHash
          }
          await this.db.put(`${this._fixed.seed}${this._fixed.msg}${authorStuff.msg}`, authorStuff)

          checkTorrent.msg = authorStuff.msg
          checkTorrent.folder = folderPath
          checkTorrent.address = null
          checkTorrent.own = true
          checkTorrent.infohash = checkTorrent.infoHash
          checkTorrent.dir = authorStuff.dir
          checkTorrent.files.forEach(file => {file.urlPath = file.path.slice(checkTorrent.name.length).replace(/\\/g, '/')})
          checkTorrent.complete = true

          if(!this.checkId.has(checkTorrent.msg)){
            this.checkId.set(checkTorrent.msg, checkTorrent)
          }
          if (path.extname(pathToData)) {
            return opts.torrent ? {data: checkTorrent.files.find(file => { return pathToData === file.urlPath }), torrent: checkTorrent} : checkTorrent.files.find(file => { return pathToData === file.urlPath })
          } else {
            return opts.torrent ? {data: checkTorrent.files.filter(file => {return file.urlPath.startsWith(pathToData)}), torrent: checkTorrent} : checkTorrent.files.filter(file => {return file.urlPath.startsWith(pathToData)})
          }
        }
      }
    }
  }
  async publishTorrent(id, pathToData, data, opts){
    if(id === false || this.checkHash.test(id)){

      const authorStuff = id ? await (async () => { await this.takeOutTorrent(id, { destroyStore: false }); return await this.db.get(`${this._fixed.seed}${this._fixed.infohash}${id}`);})() : {id, infohash: null, dir: uid(20), desc: {}}
      
      const folderPath = path.join(this._storage, authorStuff.dir)

      // await fs.ensureDir(folderPath)
      
      const dataPath = path.join(folderPath, pathToData)
      authorStuff.desc = opts.desc || authorStuff.desc
      
      const saved = Array.isArray(data) ? await this.handleFormData(dataPath, data, pathToData) : await this.handleRegData(dataPath, data, pathToData)

      const checkTorrent = await this.resOrRej(this.dataFromTorrent(folderPath, authorStuff.desc), true)

      checkTorrent.folder = folderPath
      checkTorrent.dir = authorStuff.dir

      if(authorStuff.infohash !== checkTorrent.infoHash){
        if (authorStuff.infohash) {
          await this.db.del(`${this._fixed.seed}${this._fixed.infohash}${authorStuff.infohash}`)
        }
        authorStuff.infohash = checkTorrent.infoHash
        authorStuff.id = authorStuff.infohash
        authorStuff.length = checkTorrent.length
        authorStuff.count = checkTorrent.files.length
      }
      await this.db.put(`${this._fixed.seed}${this._fixed.infohash}${authorStuff.infohash}`, authorStuff)

      if(opts.load){
        return await this.loadTorrent(authorStuff.infohash, pathToData, opts)
      } else {
        return { path: pathToData, ...authorStuff, saved }
      }
    } else if ((id === true && !opts.extra) || (this.checkAddress.test(id) && opts.extra)) {
      let prov
      let testPair = {}
      if (id === true && !opts.extra) {
        testPair = this.createKeypair()
        id = testPair.address
        opts.extra = testPair.secret
        prov = false
      } else if (id && opts.extra) {
        await this.takeOutTorrent(id, { destroyStore: false })
        prov = true
      } else {
        throw new Error('data is invalid')
      }

      const authorStuff = prov ? await (async () => { let test; try { test = await this.db.get(`${this._fixed.seed}${this._fixed.address}${id}`); test.sequence = test.sequence + 1; } catch { test = { id, address: id, sequence: 0, dir: uid(20), desc: {}, stuff: {} }; } return test; })() : {id, address: id, sequence: 0, dir: uid(20), desc: {}, stuff: {}}
      const folderPath = path.join(this._storage, authorStuff.dir)

      // await fs.ensureDir(folderPath)

      const dataPath = path.join(folderPath, pathToData)
      authorStuff.sequence = opts.seq || authorStuff.sequence
      authorStuff.desc = opts.desc || authorStuff.desc
      authorStuff.stuff = opts.stuff || authorStuff.stuff

      const saved = Array.isArray(data) ? await this.handleFormData(dataPath, data, pathToData) : await this.handleRegData(dataPath, data, pathToData)

      const checkTorrent = await this.resOrRej(this.dataFromTorrent(folderPath, authorStuff.desc), true)

      const checkProperty = await this.resOrRej(this.publishFunc(authorStuff.address, opts.extra, { ih: checkTorrent.infoHash, ...authorStuff.stuff }, authorStuff.sequence), true)
      // don't overwrite the torrent's infohash even though they will both be the same
      // checkProperty.folder = folderPath
      checkProperty.id = checkProperty.address
      checkProperty.dir = authorStuff.dir
      checkProperty.desc = authorStuff.desc
      checkProperty.length = checkTorrent.length
      checkProperty.count = checkTorrent.files.length

      await this.db.put(`${this._fixed.seed}${this._fixed.address}${checkProperty.address}`, checkProperty)

      checkTorrent.record = checkProperty

      if(opts.load){
        return await this.loadTorrent(checkProperty.address, pathToData, opts)
      } else {
        return {secret: opts.extra || null, seed: testPair.seed || null, address: id, path: pathToData, ...checkProperty, saved}
      }
    } else {
      if(pathToData !== '/' || data){
        throw new Error('path must be / and can not contain data')
      }
      const authorStuff = await (async () => { await this.takeOutTorrent(id, { destroyStore: false }); try{return await this.db.get(`${this._fixed.seed}${this._fixed.msg}${id}`)}catch{return {id, msg: id, infohash: null, dir: uid(20), desc: {}}};})()
      
      const folderPath = path.join(this._storage, authorStuff.dir)

      // await fs.ensureDir(folderPath)
      authorStuff.desc = opts.desc || authorStuff.desc

      const checkTorrent = await this.resOrRej(this.dataFromTorrent(Buffer.from(authorStuff.msg), {...authorStuff.desc, path: folderPath}), true)

      checkTorrent.msg = authorStuff.msg
      checkTorrent.folder = folderPath
      checkTorrent.dir = authorStuff.dir
      checkTorrent.infohash = checkTorrent.infoHash

      if(authorStuff.infohash !== checkTorrent.infoHash){
        if (authorStuff.infohash) {
          await this.db.del(`${this._fixed.seed}${this._fixed.msg}${authorStuff.msg}`)
        }
        authorStuff.infohash = checkTorrent.infoHash
      }
      await this.db.put(`${this._fixed.seed}${this._fixed.msg}${authorStuff.msg}`, authorStuff)

      if(opts.load){
        return await this.loadTorrent(authorStuff.msg, pathToData, opts)
      } else {
        return { path: pathToData, ...authorStuff, saved: null }
      }
    }
  }
  async shredTorrent(info, pathToData, opts){

    if(this.checkHash.test(info)){
      if(this.checkId.has(info)){
        this.checkId.delete(info)
      }
  
      const activeTorrent = await this.resOrRej(this.stopTorrent(info, { destroyStore: false }), true)

      const authorStuff = await this.resOrRej(this.db.get(`${this._fixed.seed}${this._fixed.infohash}${info}`), false)
      if(authorStuff){
        const folderPath = path.join(this._storage, authorStuff.dir)
        const dataPath = path.join(folderPath, pathToData)
  
        if(!await fs.pathExists(folderPath)){
          throw new Error('did not find any torrent data to delete')
        }
  
        if (pathToData === '/') {

          await fs.remove(folderPath)
          await this.db.del(`${this._fixed.seed}${this._fixed.infohash}${authorStuff.infohash}`)
          
          return {id: info, path: pathToData, ...authorStuff, activeTorrent}
        } else {
          if(await fs.pathExists(dataPath)){
            await fs.remove(dataPath)
            if(!(await this.getAllFiles('**/*', {cwd: folderPath, strict: false, nodir: true})).length){
              await fs.remove(folderPath)
              await this.db.del(`${this._fixed.seed}${this._fixed.infohash}${authorStuff.infohash}`)
              throw new Error('torrent can not be empty')
            }
          } else {
            throw new Error('path is not valid')
          }

          authorStuff.desc = opts.desc || authorStuff.desc
  
          const dataFromFolder = await this.resOrRej(this.dataFromTorrent(folderPath, authorStuff.desc), async () => {await fs.remove(folderPath);await this.db.del(`${this._fixed.seed}${this._fixed.infohash}${authorStuff.infohash}`);})

          if (authorStuff.infohash !== dataFromFolder.infoHash) {
            await this.db.del(`${this._fixed.seed}${this._fixed.infohash}${authorStuff.infohash}`)
            authorStuff.infohash = dataFromFolder.infoHash
            authorStuff.id = authorStuff.infohash
            authorStuff.length = dataFromFolder.length
            authorStuff.count = dataFromFolder.files.length
          }
          
          await this.db.put(`${this._fixed.seed}${this._fixed.infohash}${authorStuff.infohash}`, authorStuff)

          return {id: info, path: pathToData, ...authorStuff, activeTorrent}
        }
      } else {
        const nfoData = await this.db.get(`${this._fixed.load}${this._fixed.infohash}${info}`)
        const folderPath = path.join(this._storage, nfoData.infohash)
  
        if(!await fs.pathExists(folderPath)){
          throw new Error('did not find any torrent data to delete')
        }
  
        if(pathToData === '/'){
  
          await fs.remove(folderPath)
          await this.db.del(`${this._fixed.load}${this._fixed.infohash}${nfoData.infohash}`)

          return {id: info, path: pathToData, ...nfoData, activeTorrent}
        } else {
          const dirPath = path.join(folderPath, nfoData.name)
          const testPath = path.join(dirPath, pathToData)
          if (await fs.pathExists(testPath)) {
            await fs.remove(testPath)
          } else {
            throw new Error('path is invalid')
          }
          if(!(await this.getAllFiles('**/*', {cwd: dirPath, strict: false, nodir: true})).length){
            await fs.remove(folderPath)
            await this.db.del(`${this._fixed.load}${this._fixed.infohash}${nfoData.infohash}`)
            throw new Error('torrent can not be empty')
          }
          const testData = await this.echoHash(nfoData.infohash, folderPath, dirPath)
          return {id: info, path: pathToData, ...testData, activeTorrent}
        }
      }
    } else if(this.checkAddress.test(info)){
      if(this.checkId.has(info)){
        this.checkId.delete(info)
      }
      const activeTorrent = await this.resOrRej(this.stopTorrent(info, { destroyStore: false }), true)

      const authorStuff = await this.resOrRej(this.db.get(`${this._fixed.seed}${this._fixed.address}${info}`), false)
      if(authorStuff){
        const folderPath = path.join(this._storage, authorStuff.dir)
        const dataPath = path.join(folderPath, pathToData)
  
        if(!await fs.pathExists(folderPath)){
          throw new Error('did not find any torrent data to delete')
        }
  
        if (pathToData === '/') {
          
          await fs.remove(folderPath)
          await this.db.del(`${this._fixed.seed}${this._fixed.address}${authorStuff.address}`)

          return {id: info, path: pathToData, ...authorStuff, activeTorrent}
        } else {
          if(!info.extra){
            throw new Error('secret key is request')
          }
          if(await fs.pathExists(dataPath)){
            await fs.remove(dataPath)
            if(!(await this.getAllFiles('**/*', {cwd: folderPath, strict: false, nodir: true})).length){
              await fs.remove(folderPath)
              await this.db.del(`${this._fixed.seed}${this._fixed.address}${authorStuff.address}`)
              throw new Error('torrent can not be empty')
            }
          } else {
            throw new Error('path is invalid')
          }
          
          authorStuff.desc = opts.desc || authorStuff.desc || {}
  
          const dataFromFolder = await this.resOrRej(this.dataFromTorrent(folderPath, authorStuff.desc), async () => {await fs.remove(folderPath);await this.db.del(`${this._fixed.seed}${this._fixed.address}${authorStuff.address}`);})

          const dataFromProp = await this.resOrRej(this.publishFunc(authorStuff.address, info.extra, {...authorStuff.stuff, ih: dataFromFolder.infoHash}, authorStuff.sequence + 1), true)
          dataFromProp.dir = authorStuff.dir
          dataFromProp.desc = authorStuff.desc
          dataFromProp.length = dataFromFolder.length
          dataFromProp.count = dataFromFolder.files.length
          dataFromProp.id = dataFromProp.address

          await this.db.put(`${this._fixed.seed}${this._fixed.address}${dataFromProp.address}`, dataFromProp)
  
          return {id: info, path: pathToData, ...authorStuff, activeTorrent}
        }
      } else {
        const nfoData = await this.db.get(`${this._fixed.load}${this._fixed.address}${info}`)
        const folderPath = path.join(this._storage, nfoData.address)
  
        if(!await fs.pathExists(folderPath)){
          throw new Error('did not find any torrent data to delete')
        }
  
        if(pathToData === '/'){
  
          await fs.remove(folderPath)
          await this.db.del(`${this._fixed.load}${this._fixed.address}${nfoData.address}`)

          return {id: info, path: pathToData, ...nfoData, activeTorrent}
        } else {
          const mainPath = path.join(folderPath, nfoData.infohash)
          const dataPath = path.join(mainPath, nfoData.name)
          const testPath = path.join(dataPath, pathToData)
          if (await fs.pathExists(testPath)) {
            await fs.remove(testPath)
          } else {
            throw new Error('path is invalid')
          }
          if(!(await this.getAllFiles('**/*', {cwd: dataPath, strict: false, nodir: true})).length){
            await fs.remove(folderPath)
            await this.db.del(`${this._fixed.load}${this._fixed.address}${nfoData.address}`)
            throw new Error('torrent can not be empty')
          }
          const testData = await this.echoAddress(nfoData.address, folderPath, dataPath)
          return {id: info, path: pathToData, ...testData, activeTorrent}
        }
      }
    } else {
      if(pathToData !== '/'){
        throw new Error('path must be / when deleting torrents for messages')
      }
      if(this.checkId.has(info)){
        this.checkId.delete(info)
      }
  
      const activeTorrent = await this.resOrRej(this.stopTorrent(info, { destroyStore: false }), true)

      const authorStuff = await this.resOrRej(this.db.get(`${this._fixed.seed}${this._fixed.msg}${info}`), false)
      if(authorStuff){
        const folderPath = path.join(this._storage, authorStuff.dir)
  
        if(!await fs.pathExists(folderPath)){
          throw new Error('did not find any torrent data to delete')
        }

        await fs.remove(folderPath)
        await this.db.del(`${this._fixed.seed}${this._fixed.msg}${authorStuff.msg}`)
        
        return {id: info, path: pathToData, ...authorStuff, torrent: activeTorrent}
      } else {
        return {id: info, path: pathToData, torrent: activeTorrent}
      }
    }
  }
  async dataFromTorrent(folder, opts){
    const test = await new Promise((resolve, reject) => {
      createTorrent(folder, opts, (err, torrent) => {
        if(err){
          reject(err)
        } else if(torrent){
          resolve(torrent)
        } else {
          reject(new Error('could not get torrent data from the folder'))
        }
      })
    })
    return parseTorrent(test)
  }
  async echoAddress(id, folderPath, mainPath, opts) {
    if (!opts) {
      opts = {}
    }
    const dir = uid(20)
    const dirPath = path.join(this._storage, dir)
    await fs.ensureDir(dirPath)
    await fs.copy(mainPath, dirPath, {overwrite: true})
    await fs.remove(folderPath)
    await this.db.del(`${this._fixed.load}${this._fixed.address}${id}`)
    const descripPath = opts.desc || {}
    const stuffPath = opts.stuff || {}
    const dataFromDir = await this.dataFromTorrent(dirPath, descripPath)
    const pairID = this.createKeypair()
    const pubTorrentData = await this.publishFunc(pairID.address, pairID.extra, {ih: dataFromDir.infoHash, ...stuffPath}, 0)
    pubTorrentData.dir = dir
    pubTorrentData.desc = descripPath
    pubTorrentData.echo = id
    pubTorrentData.id = id
    pubTorrentData.length = dataFromDir.length
    pubTorrentData.count = dataFromDir.files.length
    await this.db.put(`${this._fixed.seed}${this._fixed.address}${pubTorrentData.address}`, pubTorrentData)
    for (const test in pairID) {
      pubTorrentData[test] = pairID[test]
    }
    return pubTorrentData
  }
  async echoHash(id, folderPath, movePath, opts){
    // const mainArr = await fs.readdir(folderPath, {withFileTypes: true})
    if (!opts) {
      opts = {}
    }
    const descripPath = opts.desc || {}
    const dir = uid(20)
    const dirPath = path.join(this._storage, dir)
    await fs.ensureDir(dirPath)
    await fs.copy(movePath, dirPath, { overwrite: true })
    await fs.remove(folderPath)
    await this.db.del(`${this._fixed.load}${this._fixed.infohash}${id}`)
    const dataFromDir = await this.dataFromTorrent(dirPath, descripPath)
    const pubTorrentData = { id, infohash: dataFromDir.infoHash, dir: dir, echo: id, desc: descripPath, size: dataFromDir.length, length: dataFromDir.files.length }
    await this.db.put(`${this._fixed.seed}${this._fixed.infohash}${pubTorrentData.infohash}`, pubTorrentData)
    return pubTorrentData
  }
  getAllFiles(data, opts){
    return new Promise((resolve, reject) => {
      glob(data, opts, function (err, files) {
        if(err){
          reject(err)
        } else {
          resolve(files)
        }
      })
    })
  }
  midTorrent(id, opts){
    return new Promise((resolve, reject) => {
      this.webtorrent.add(id, opts, torrent => {
        // torrent.onData = (buf) => {
        //   torrent.emit('msg', buf)
        // }
        // torrent.extendTheWire = (wire, addr) => {
        //   wire.use(ut_msg(addr))
        //   wire.ut_msg.on('msg', torrent.onData)
        // }
        // torrent.on('wire', torrent.extendTheWire)
        // torrent.say = (message) => {
        //   torrent.wires.forEach((data) => {
        //     if(data.ut_msg){
        //       data.ut_msg.send(message)
        //     }
        //   })
        // }
        resolve(torrent)
      })
    })
  }
  startTorrent(folder, opts){
    return new Promise((resolve, reject) => {
      this.webtorrent.seed(folder, opts, torrent => {
        if(Buffer.isBuffer(folder)){
          torrent.onData = (buf) => {
            try {
              if(buf.includes(58)){
                const i = buf.indexOf(58)
                if(!isNaN(buf.subarray(0, i).toString())){
                  buf = buf.subarray(i + 1)
                }
              }
            } catch (e) {
              console.error(e)
            }
            torrent.emit('msg', buf)
          }
          torrent.extendTheWire = (wire, addr) => {
            wire.use(ut_msg(crypto.createHash('sha1').update(addr).digest('hex')))
            wire.ut_msg.on('msg', torrent.onData)
          }
          torrent.on('wire', torrent.extendTheWire)
          torrent.say = (message) => {
            torrent.wires.forEach((data) => {
              if(data.ut_msg){
                data.ut_msg.send(message)
              }
            })
          }
        }
        resolve(torrent)
      })
    })
  }
  stopTorrent(dataForTorrent, opts) {
    return new Promise((resolve, reject) => {
        const getTorrent = this.findTheTorrent(dataForTorrent)
        if (getTorrent) {
          if(getTorrent.msg){
            getTorrent.emit('over')
            getTorrent.wires.forEach((data) => {
              data.ut_msg.off('msg', getTorrent.onData)
            })
            getTorrent.off('wire', getTorrent.extendTheWire)
          }
          getTorrent.destroy(opts, (error) => {
            if (error) {
              reject(error)
            } else {
              resolve(dataForTorrent)
            }
          })
        } else {
          resolve(dataForTorrent)
        }
    })
  }

  findTheTorrent(id){
    let data = null
    for(const torrent of this.webtorrent.torrents){
      if(torrent.id === id){
        data = torrent
        break
      }
    }
    return data
  }

  checkTheTorrent(id){
    return this.checkId.has(id) ? this.checkId.get(id) : this.findTheTorrent(id)
  }

  async handleFormData(folderPath, data, fullPath) {
    await fs.ensureDir(folderPath)
    const arr = []
    for (const info of data) {
      const useName = info.webkitRelativePath || info.name
      const tempPath = path.join(folderPath, useName)
      await this.resOrRej(pipelinePromise(Readable.from(info.stream()), fs.createWriteStream(tempPath)), true)
      arr.push(path.join(fullPath, useName).replace(/\\/g, "/"))
    }
    return arr
  }

  async handleRegData(mainPath, body, fullPath) {
    await fs.ensureDir(path.dirname(mainPath))
    await this.resOrRej(pipelinePromise(Readable.from(body), fs.createWriteStream(mainPath)), true)
    return fullPath
  }

  // -------------- the below functions are BEP46 helpers ----------------

  // keep the data we currently hold active by putting it back into the dht
  saveData (data) {
    return new Promise((resolve, reject) => {
      this.webtorrent.dht.put({ k: Buffer.from(data.address, 'hex'), v: { ih: Buffer.from(data.infohash || data.infoHash, 'hex'), ...this.stuffToBuf(data.stuff) }, seq: data.sequence, sig: Buffer.from(data.sig, 'hex') }, (error, hash, number) => {
        if (error) {
          reject(error)
        } else {
          resolve({ hash: hash.toString('hex'), number })
        }
      })
    })
  }

  // create a keypair
  createKeypair (data) {
    const seed = data ? Buffer.from(data, 'hex') : ed.createSeed()
    const { publicKey, secretKey } = ed.createKeyPair(seed)
    return { address: publicKey.toString('hex'), secret: secretKey.toString('hex'), seed: seed.toString('hex') }
  }

  // generateKeypair (data) {
  //   const { publicKey, secretKey } = ed.createKeyPair(data)
  //   return { address: publicKey.toString('hex'), secret: secretKey.toString('hex'), seed: data.toString('hex') }
  // }

  // obj to buf for stuff
  stuffToBuf(data){
    const obj = {}
    for(const prop in data){
      obj[prop] = Buffer.from(data[prop], 'utf-8')
    }
    return obj
  }

  // buff to obj for stuff
  stuffToObj(data){
    const obj = {}
    for(const prop in data){
      obj[prop] = data[prop].toString('utf-8')
    }
    return obj
  }

  async authorData() {
    return await this.db.values({ gt: this._fixed.seed }).all()
  }

  async torrentData(data) {
    const parseFiles = []
    for await (const test of this.db.values({ gt: this._fixed.seed })) {
      parseFiles.push(test)
    }
    for await (const test of this.db.values({ gt: this._fixed.load })) {
      parseFiles.push(test)
    }
    return data ? parseFiles : parseFiles.map((data) => {if (data.address) {return data.address} else {return data.infohash}})
  }
}