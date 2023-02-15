const WebTorrent = require('webtorrent')
const fs = require('fs-extra')
const path = require('path')
const sha1 = require('simple-sha1')
const ed = require('ed25519-supercop')
const bencode = require('bencode')
const { pipelinePromise, Readable } = require('streamx')
const wrtc = require('wrtc')
const createTorrent = require('create-torrent')
const parseTorrent = require('parse-torrent')
const {uid} = require('uid')
const glob = require("glob")
const crypto = require('crypto')

// saves us from saving secret keys(saving secret keys even encrypted secret keys is something i want to avoid)
// with this function which was taken from the bittorrent-dht package
// we save only the signatures when we first publish a BEP46 torrent

class Torrentz {
  constructor (opts = {}) {
    const defOpts = { folder: __dirname, storage: 'storage', author: 'author', description: 'description', user: 'user', routine: 3600000 }
    const finalOpts = { ...defOpts, ...opts }
    // this._timeout = finalOpts.timeout
    this._routine = finalOpts.routine
    this.checkHash = /^[a-fA-F0-9]{40}$/
    this.checkAddress = /^[a-fA-F0-9]{64}$/
    this.checkTitle = /^[a-zA-Z0-9]{16}$/

    finalOpts.folder = path.resolve(finalOpts.folder)
    fs.ensureDirSync(finalOpts.folder)

    this._folder = finalOpts.folder
    this._storage = path.join(this._folder, finalOpts.storage)
    this._author = path.join(this._folder, finalOpts.author)
    this._description = path.join(this._folder, finalOpts.description)
    this._user = path.join(this._folder, finalOpts.user)
    this._name = 'hybrid'
    this._seed = path.join(this._folder, 'seed')
    if (!fs.pathExistsSync(this._storage)) {
      fs.ensureDirSync(this._storage)
    }
    if (!fs.pathExistsSync(this._author)) {
      fs.ensureDirSync(this._author)
    }
    if (!fs.pathExistsSync(this._description)) {
      fs.ensureDirSync(this._description)
    }
    if(fs.pathExistsSync(this._seed)){
      this.seedData = fs.readFileSync(this._seed)
    } else {
      this.seedData = crypto.randomBytes(32)
      fs.writeFileSync(this._seed, this.seedData)
    }
    if (!fs.pathExistsSync(this._user)) {
      fs.ensureDirSync(this._user)
    }

    // this.webtorrent = finalOpts.webtorrent ? finalOpts.webtorrent : new WebTorrent({ dht: { verify: ed.verify }, tracker: {wrtc} })
    this.webtorrent = new WebTorrent({ ...finalOpts, dht: { verify: ed.verify }, tracker: {wrtc} })

    globalThis.WEBTORRENT_ANNOUNCE = createTorrent.announceList.map(arr => arr[0]).filter(url => url.indexOf('wss://') === 0 || url.indexOf('ws://') === 0)
    globalThis.WRTC = wrtc
    
    this.webtorrent.on('error', error => {
      console.error(error)
    })

    this.checkId = new Map()
    this.BTPK_PREFIX = 'urn:btpk:'
    this._readyToGo = true

    // run the start up function
    // this.startUp().catch(error => { console.error(error) })

    // run the keepUpdated function every 1 hour, it keep the data active by putting the data back into the dht, don't run it if it is still working from the last time it ran the keepUpdated function
    this.session = setInterval(() => {
      if (this._readyToGo) {
        this.keepUpdated().then(data => console.log('amount of torrents:', data)).catch(error => console.error('routine update had a reject', error))
      }
    }, this._routine)
  }

  async userTorrent(torrent, pathToData, opts = {}) {
    if (!opts) {
      opts = {}
    }
    const useTimeout = opts.timeout
    const useId = torrent.infohash || torrent.address || this.createKeypair(torrent.title).address
    const torrentStuff = await this.loadTorrent(torrent, pathToData, {timeout: useTimeout})
    if (torrentStuff.infoHash) {
      // saves all files in the user dir
      for (const test of torrentStuff.files) {
        const dataToSave = await new Promise((resolve, reject) => {
          test.getBuffer((err, buf) => {
            if (err) {
              return reject(err)
            }
            return resolve(buf)
          })
        })
        const dataPathToSave = opts.id ? path.join(this._user, torrentStuff.address || torrentStuff.infohash, torrentStuff.path) : path.join(this._user, torrentStuff.path)
        await fs.writeFile(dataPathToSave, dataToSave.buffer)
        return dataPathToSave
      }
    } else if (Array.isArray(torrentStuff)) {
      for (const test of torrentStuff) {
        const dataToSave = await new Promise((resolve, reject) => {
          test.getBuffer((err, buf) => {
            if (err) {
              return reject(err)
            }
            return resolve(buf)
          })
        })
        const dataPathToSave = opts.id ? path.join(this._user, `${useId}`, torrentStuff.path) : path.join(this._user, torrentStuff.path)
        await fs.writeFile(dataPathToSave, dataToSave.buffer)
        return dataPathToSave
      }
    } else if (torrentStuff) {
        const dataToSave = await new Promise((resolve, reject) => {
          test.getBuffer((err, buf) => {
            if (err) {
              return reject(err)
            }
            return resolve(buf)
          })
        })
      const dataPathToSave = opts.id ? path.join(this._user, `${useId}`, torrentStuff.path) : path.join(this._user, torrentStuff.path)
      await fs.writeFile(dataPathToSave, dataToSave.buffer)
      return dataPathToSave
    } else {
      throw new Error('did not find any torrent data')
    }
  }

  encodeSigData (msg) {
    const ref = { seq: msg.seq, v: msg.v }
    if (msg.salt) ref.salt = msg.salt
    return bencode.encode(ref).slice(1, -1)
  }

  // keep data active in the dht, runs every hour
  async keepUpdated () {
    this._readyToGo = false
    const dir = await (async () => {const test = await fs.readdir(this._author);return test.filter((data) => {return data.length === 64});})()
    for(const data of dir){
      const useData = await fs.readFile(path.join(this._author, data))
      const parsedData = JSON.parse(useData.toString())
      try {
        await this.saveData(parsedData)
      } catch (err) {
        console.error(parsedData.address, err)
      }
      await new Promise((resolve, reject) => setTimeout(resolve, 4000))
    }
    for (const torrent of this.webtorrent.torrents) {
      if (torrent.address && !torrent.own) {
        try {
          await this.saveData(torrent)
        } catch (err) {
          console.error(torrent.address, err)
        }
        await new Promise((resolve, reject) => setTimeout(resolve, 4000))
      }
    }
    this._readyToGo = true
    return this.webtorrent.torrents.length
  }

  async handleTheData(useTimeOut, waitForData, cb) {
    try {
      if (useTimeOut.num) {
        return await Promise.race([
          new Promise((resolve, reject) => { setTimeout(() => { if (useTimeOut.res) { resolve(`${useTimeOut.id} took too long, it timed out - ${useTimeOut.kind}`) } else { const err = new Error(`${useTimeOut.id} took too long, it timed out - ${useTimeOut.kind}`); err.name = 'ErrorTimeout'; reject(err); } }, useTimeOut.num) }),
          waitForData
        ])
      } else {
        return await waitForData
      }
    } catch (error) {
      if (cb) {
        await cb()
      }
      throw error
    }
  }

  // when we resume or seed a user created BEP46 torrent that has already been created before
  // we have to check that the infohash of the torrent(remember we do not know the infohash before) matches the signature
  // if it does not match, that means the data/torrent has been corrupted somehow
  async ownData (data, infoHash) {
    const hashBuff = Buffer.from(infoHash, 'hex')
    const signatureBuff = Buffer.from(data.sig, 'hex')
    const stuffBuff = this.stuffToBuff(data.stuff)
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
    const addressKey = Buffer.from(address, 'hex')
    const getData = await new Promise((resolve, reject) => {
      sha1(addressKey, (targetID) => {
        this.webtorrent.dht.get(targetID, (err, res) => {
          if (err) {
            reject(err)
          } else if (res) {
            resolve(res)
          } else if (!res) {
            reject(new Error('Could not resolve address'))
          }
        })
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

    return { magnet: `magnet:?xs=${this.BTPK_PREFIX}${address}`, address, infohash: ih, sequence: getData.seq, stuff, sig: getData.sig.toString('hex'), from: getData.id.toString('hex') }
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
    return { magnet: `magnet:?xs=${this.BTPK_PREFIX}${address}`, address, infohash: ih, sequence: seq, stuff, sig: buffSig.toString('hex'), ...putData }
  }

  checkForTorrent(id, pathToData){
    if(this.checkId.has(id)){
      return pathToData === '/' ? this.checkId.get(id) : pathToData.includes('.') ? this.checkId.get(id).files.find(file => { return pathToData === file.urlPath }) : mainData.files.filter(file => {return file.urlPath.includes(pathToData)})
    }
    const mainData = this.findTheTorrent(id)
    if(mainData){
      this.checkId.set(id, mainData)
      return pathToData === '/' ? mainData : pathToData.includes('.') ? mainData.files.find(file => { return pathToData === file.urlPath }) : mainData.files.filter(file => {return file.urlPath.includes(pathToData)})
    }
    return null
  }

  async takeOutTorrent(data){
    if(this.checkId.has(data)){
      this.checkId.delete(data)
    }
    const activeTorrent = this.findTheTorrent(data)
    if(activeTorrent){
      // await this.stopTorrent(activeTorrent.infoHash, {destroyStore: false})
      activeTorrent.destroy({destroyStore: false})
    }
  }

  async loadTorrent(id, pathToData, opts = {}){
    if(!opts){
      opts = {}
    }

    const useTimeout = opts.timeout

    if(id.infohash){
      const testTorrent = this.checkForTorrent(id.infohash, pathToData)
      if(testTorrent){
        return testTorrent
      }
      const authorPath = path.join(this._author, id.infohash)
      if (await fs.pathExists(authorPath)) {
        const authorStuff = JSON.parse((await fs.readFile(authorPath)).toString())
        const folderPath = path.join(this._storage, authorStuff.dir)
        const descriptionPath = path.join(this._description, authorStuff.dir)
        const useOpts = await (async () => {if(await fs.pathExists(descriptionPath)){const test = await fs.readFile(descriptionPath);return JSON.parse(test.toString());}else{return {}}})()
        const checkTorrent = await this.handleTheData({ id: authorStuff.infohash, num: useTimeout, kind: 'start', res: false }, this.startTorrent(folderPath, { ...useOpts, destroyStoreOnDestroy: false }), async () => {await this.stopTorrent(authorStuff.infohash, { destroyStore: false })})
        
        if(checkTorrent.infoHash !== authorStuff.infohash){
          this.webtorrent.remove(checkTorrent.infoHash, { destroyStore: false }) 
          throw new Error('infohash does not match with the given infohash')
        }
        // const mainPath = path.join(checkTorrent.path, checkTorrent.name)
        checkTorrent.folder = folderPath
        checkTorrent.address = null
        checkTorrent.own = true
        checkTorrent.infohash = checkTorrent.infoHash
        checkTorrent.dir = authorStuff.dir
        checkTorrent.files.forEach(file => {file.urlPath = file.path.slice(checkTorrent.name.length).replace(/\\/g, '/')})
        this.checkId.set(checkTorrent.infohash, checkTorrent)
        return pathToData === '/' ? checkTorrent : pathToData.includes('.') ? checkTorrent.files.find(file => { return pathToData === file.urlPath }) : checkTorrent.files.filter(file => {return file.urlPath.includes(pathToData)})
      } else {
        const folderPath = path.join(this._storage, id.infohash)
        const checkTorrent = await this.handleTheData({id: id.infohash, num: useTimeout, kind: 'mid', res: false }, this.midTorrent(id.infohash, { path: folderPath, destroyStoreOnDestroy: false }), async () => {await this.stopTorrent(id.infohash, { destroyStore: false })})
        await fs.writeFile(path.join(folderPath, 'nfo.txt'), checkTorrent.name)
        checkTorrent.folder = folderPath
        checkTorrent.address = null
        checkTorrent.own = false
        checkTorrent.dir = null
        checkTorrent.infohash = checkTorrent.infoHash
        checkTorrent.files.forEach(file => {file.urlPath = file.path.slice(checkTorrent.name.length).replace(/\\/g, '/')})
        this.checkId.set(checkTorrent.infohash, checkTorrent)
        return pathToData === '/' ? checkTorrent : pathToData.includes('.') ? checkTorrent.files.find(file => { return pathToData === file.urlPath }) : checkTorrent.files.filter(file => {return file.urlPath.includes(pathToData)})
      }
    } else if(id.address || id.title){
      if(!id.address){
        id.address = this.createKeypair(id.title).address
      }
      const testTorrent = this.checkForTorrent(id.address, pathToData)
      if(testTorrent){
        return testTorrent
      }
      const authorPath = path.join(this._author, id.address)
      if(await fs.pathExists(authorPath)){
        const authorStuff = JSON.parse((await fs.readFile(authorPath)).toString())
        const folderPath = path.join(this._storage, authorStuff.dir)
        const descriptionPath = path.join(this._description, authorStuff.dir)
        const useOpts = await (async () => {if(await fs.pathExists(descriptionPath)){const test = await fs.readFile(descriptionPath);return JSON.parse(test.toString());}else{return {}}})()

        const checkTorrent = await this.handleTheData({ id: authorStuff.address, num: useTimeout, kind: 'start', res: false }, this.startTorrent(folderPath, { ...useOpts, destroyStoreOnDestroy: true }), async () => {await this.stopTorrent(authorStuff.infohash, { destroyStore: false })})
        if(checkTorrent.infoHash !== authorStuff.infohash){
          this.webtorrent.remove(checkTorrent.infoHash, { destroyStore: false })
          throw new Error('infohash does not match with the given infohash')
        }

        const checkProperty = await this.handleTheData({ id: authorStuff.address, num: useTimeout, kind: 'own', res: false }, this.ownData(authorStuff, checkTorrent.infoHash), async () => {await this.stopTorrent(checkTorrent.infoHash, { destroyStore: false })})
        // don't overwrite the torrent's infohash even though they will both be the same
        checkProperty.folder = folderPath
        for (const prop in checkProperty) {
          checkTorrent[prop] = checkProperty[prop]
        }
        // const mainPath = path.join(checkTorrent.path, checkTorrent.name)
        checkTorrent.dir = null
        checkTorrent.own = true
        checkTorrent.files.forEach(file => {file.urlPath = file.path.slice(checkTorrent.name.length).replace(/\\/g, '/')})
        this.checkId.set(checkTorrent.address, checkTorrent)
        return pathToData === '/' ? checkTorrent : pathToData.includes('.') ? checkTorrent.files.find(file => { return pathToData === file.urlPath }) : checkTorrent.files.filter(file => {return file.urlPath.includes(pathToData)})
      } else {
        const folderPath = path.join(this._storage, id.address)

        const checkProperty = await this.handleTheData({ id: id.address, num: useTimeout, kind: 'resolve', res: false }, this.resolveFunc(id.address), null)

        checkProperty.folder = folderPath
        const dataPath = path.join(checkProperty.folder, checkProperty.infohash)

        if (!await fs.pathExists(dataPath)) {
          await fs.emptyDir(checkProperty.folder)
          await fs.writeFile(path.join(checkProperty.folder, 'nfo.txt'), checkProperty.infohash)
        }

        const checkTorrent = await this.handleTheData({ id: checkProperty.address, num: useTimeout, kind: 'mid', res: false }, this.midTorrent(checkProperty.infohash, { path: dataPath, destroyStoreOnDestroy: false }), async () => { await this.stopTorrent(checkProperty.infohash, { destroyStore: false }) })
        await fs.writeFile(path.join(dataPath, 'nfo.txt'), checkTorrent.name)
        // don't overwrite the torrent's infohash even though they will both be the same
        for (const prop in checkProperty) {
          checkTorrent[prop] = checkProperty[prop]
        }
        // const mainPath = path.join(checkTorrent.path, checkTorrent.name)
        checkTorrent.own = false
        checkTorrent.dir = null
        checkTorrent.files.forEach(file => {file.urlPath = file.path.slice(checkTorrent.name.length).replace(/\\/g, '/')})
        this.checkId.set(checkTorrent.address, checkTorrent)
        return pathToData === '/' ? checkTorrent : pathToData.includes('.') ? checkTorrent.files.find(file => { return pathToData === file.urlPath }) : checkTorrent.files.filter(file => {return file.urlPath.includes(pathToData)})
      }
    } else {
      throw new Error('invalid identifier was used')
    }
  }
  async publishTorrent(id, pathToData, data, opts = {}){
    if(!opts){
      opts = {}
    }
    const useTimeout = opts.timeout
    if(id.infohash || id.infohash === null){

      id = id.infohash ? await (async () => {if(this.checkId.has(id.infohash)){this.checkId.delete(id.infohash)}const activeTorrent = this.findTheTorrent(id.infohash);if(activeTorrent){activeTorrent.destroy({destroyStore: false})};return JSON.parse((await fs.readFile(path.join(this._author, id.infohash))).toString());})() : {infohash: null, dir: uid(20)}
      
      const folderPath = path.join(this._storage, id.dir)

      await fs.ensureDir(folderPath)
      
      const dataPath = path.join(folderPath, pathToData)
      const descriptionPath = path.join(this._description, id.dir)
      const useOpts = await (async () => {if(opts.opt){await fs.writeFile(descriptionPath, JSON.stringify(opts.opt));return opts.opt;}else if(await fs.pathExists(descriptionPath)){const test = await fs.readFile(descriptionPath);return JSON.parse(test.toString());}else{return {};}})()
      // const useOpts = await (async () => {if(await fs.pathExists(descriptionPath)){const test = await fs.readFile(descriptionPath);return JSON.parse(test.toString());}else if(opts.opt){await fs.writeFile(descriptionPath, JSON.stringify(opts.opt));return opts.opt;}else{return {};}})()
      
      const saved = Array.isArray(data) ? await this.handleFormData(dataPath, data, useTimeout) : await this.handleRegData(dataPath, data, useTimeout)
      const extraFile = path.join(folderPath, 'neta.json')
      if (await fs.pathExists(extraFile)) {
        const extraData = JSON.parse((await fs.readFile(extraFile)).toString())
        extraData.neta = extraData.neta + 1
        await fs.writeFile(extraFile, JSON.stringify(extraData))
      } else {
        await fs.writeFile(extraFile, JSON.stringify({neta: 0}))
      }

      const checkTorrent = await this.handleTheData({ id: 'torrent', num: useTimeout, kind: 'data', res: false }, this.dataFromTorrent(folderPath, useOpts), null)

      checkTorrent.folder = folderPath
      checkTorrent.dir = id.dir

      if(id.infohash && checkTorrent.infoHash !== id.infohash){
        await fs.remove(path.join(this._author, id.infohash))
      }
      const authorPath = path.join(this._author, checkTorrent.infoHash)
      await fs.writeFile(authorPath, JSON.stringify({infohash: checkTorrent.infoHash, dir: checkTorrent.dir}))

      return { infohash: checkTorrent.infoHash, dir: checkTorrent.dir, saved }
    } else if((id.address && id.secret) || (id.address === null && id.secret === null) || id.title || id.title === null){

      if(!id.address || !id.secret){
        if(id.title){
          id = this.createKeypair(id.title)
          await this.takeOutTorrent(id.address)
        } else {
          id = this.createKeypair(null)
        }
      } else {
        await this.takeOutTorrent(id.address)
      }

      const authorPath = path.join(this._author, id.address)
      if (await fs.pathExists(authorPath)) {
        const authorStuff = JSON.parse((await fs.readFile(authorPath)).toString())
        const folderPath = path.join(this._storage, authorStuff.dir)
  
        await fs.ensureDir(folderPath)
  
        const dataPath = path.join(folderPath, pathToData)
        const descriptionPath = path.join(this._description, authorStuff.dir)
        const useOpts = await (async () => {if(await fs.pathExists(descriptionPath)){const test = await fs.readFile(descriptionPath);return JSON.parse(test.toString());}else if(opts.opt){await fs.writeFile(descriptionPath, JSON.stringify(opts.opt));return opts.opt;}else{return {};}})()
  
        const saved = Array.isArray(data) ? await this.handleFormData(dataPath, data, useTimeout) : await this.handleRegData(dataPath, data, useTimeout)
        const extraFile = path.join(folderPath, 'neta.json')
        if (await fs.pathExists(extraFile)) {
          const extraData = JSON.parse((await fs.readFile(extraFile)).toString())
          extraData.neta = extraData.neta + 1
          await fs.writeFile(extraFile, JSON.stringify(extraData))
        } else {
          await fs.writeFile(extraFile, JSON.stringify({neta: 0}))
        }
  
        const checkTorrent = await this.handleTheData({ id: 'torrent', num: useTimeout, kind: 'data', res: false }, this.dataFromTorrent(folderPath, useOpts), null)

        const checkProperty = await this.handleTheData({ id: authorStuff.address, num: useTimeout, kind: 'publish', res: false }, this.publishFunc(authorStuff.address, id.secret, { ih: checkTorrent.infoHash }, opts.count ? opts.count : authorStuff.sequence + 1), null)
        // don't overwrite the torrent's infohash even though they will both be the same
        checkProperty.folder = folderPath
        checkProperty.dir = authorStuff.dir

        await fs.writeFile(authorPath, JSON.stringify(checkProperty))

        return { secret: id.secret, title: id.title, address: checkProperty.address, infohash: checkProperty.infohash, dir: checkProperty.dir, sequence: checkProperty.sequence, saved}
      } else {
        const dir = uid(20)
        const folderPath = path.join(this._storage, dir)
  
        await fs.ensureDir(folderPath)
  
        const dataPath = path.join(folderPath, pathToData)
        const descriptionPath = path.join(this._description, dir)
        const useOpts = await (async () => {if(await fs.pathExists(descriptionPath)){const test = await fs.readFile(descriptionPath);return JSON.parse(test.toString());}else if(opts.opt){await fs.writeFile(descriptionPath, JSON.stringify(opts.opt));return opts.opt;}else{return {};}})()
  
        const saved = Array.isArray(data) ? await this.handleFormData(dataPath, data, useTimeout) : await this.handleRegData(dataPath, data, useTimeout)
        const extraFile = path.join(folderPath, 'neta.json')
        if (await fs.pathExists(extraFile)) {
          const extraData = JSON.parse((await fs.readFile(extraFile)).toString())
          extraData.neta = extraData.neta + 1
          await fs.writeFile(extraFile, JSON.stringify(extraData))
        } else {
          await fs.writeFile(extraFile, JSON.stringify({neta: 0}))
        }
  
        const checkTorrent = await this.handleTheData({ id: 'torrent', num: useTimeout, kind: 'data', res: false }, this.dataFromTorrent(folderPath, useOpts), null)

        const checkProperty = await this.handleTheData({ id: id.address, num: useTimeout, kind: 'publish', res: false }, this.publishFunc(id.address, id.secret, { ih: checkTorrent.infoHash }, opts.count ? opts.count : 0), null)
        // don't overwrite the torrent's infohash even though they will both be the same
        checkProperty.folder = folderPath
        checkProperty.dir = dir
        
        const authorPath = path.join(this._author, checkProperty.address)
        await fs.writeFile(authorPath, JSON.stringify(checkProperty))

        return { secret: id.secret, title: id.title, dir: checkProperty.dir, address: checkProperty.address, infohash: checkProperty.infohash, sequence: checkProperty.sequence, saved}
      }
    } else {
      throw new Error('title or address/secret is needed or needs to be null')
    }
  }
  async shredTorrent(info, pathToData, opts = {}){
    if(!opts){
      opts = {}
    }

    const useTimeout = opts.timeout

    if(info.infohash){
      if(this.checkId.has(info.infohash)){
        this.checkId.delete(info.infohash)
      }
  
      const activeTorrent = await this.handleTheData({ id: info.infohash, num: useTimeout, kind: 'stop', res: false }, this.stopTorrent(info.infohash, { destroyStore: false }), null)
      
      const authorPath = path.join(this._author, info.infohash)
      if(await fs.pathExists(authorPath)){
        const authorStuff = JSON.parse((await fs.readFile(authorPath)).toString()) 
        const folderPath = path.join(this._storage, authorStuff.dir)
        const descriptionPath = path.join(this._description, authorStuff.dir)
        const dataPath = path.join(folderPath, pathToData)
  
        if(!await fs.pathExists(folderPath)){
          throw new Error('did not find any torrent data to delete')
        }
  
        if (pathToData === '/') {
          
          await fs.remove(authorPath)
          await fs.remove(folderPath)
          await fs.remove(descriptionPath)
          
          return {id: info.infohash, path: pathToData, infohash: info.infohash, activeTorrent}
        } else {
          if(await fs.pathExists(dataPath)){
            await fs.remove(dataPath)
            if(!(await this.getAllFiles('**/*', {cwd: folderPath, strict: false, nodir: true})).length){
              await fs.remove(authorPath)
              await fs.remove(folderPath)
              await fs.remove(descriptionPath)
              throw new Error('torrent can not be empty')
            }
          } else {
            throw new Error('path is not valid')
          }
  
          const useOpts = descriptionPath ? await (async () => {if(await fs.pathExists(descriptionPath)){const test = await fs.readFile(descriptionPath);return JSON.parse(test.toString());}else{return {};}})() : {}
  
          const dataFromFolder = await (async () => {
            try {
              return await this.dataFromTorrent(folderPath, useOpts)
            } catch (err) {
              await fs.remove(authorPath)
              await fs.remove(folderPath)
              await fs.remove(descriptionPath)
              throw err
            }
          })()

          await fs.remove(authorPath)
          await fs.writeFile(path.join(this._author, dataFromFolder.infoHash), JSON.stringify({infohash: dataFromFolder.infoHash, dir: authorStuff.dir}))

          return {id: info.infohash, path: pathToData, infohash: dataFromFolder.infoHash, activeTorrent}
        }
      } else {
        const folderPath = path.join(this._storage, info.infohash)
  
        if(!await fs.pathExists(folderPath)){
          throw new Error('did not find any torrent data to delete')
        }
  
        if(pathToData === '/'){
  
          await fs.remove(folderPath)

          return {id: info.infohash, path: pathToData, infohash: info.infohash, activeTorrent}
        } else {
          const nfoFile = path.join(folderPath, 'nfo.txt')
          const dirPath = path.join(folderPath, (await fs.readFile(nfoFile)).toString())
          const testPath = path.join(dirPath, pathToData)
          if (await fs.pathExists(testPath)) {
            await fs.remove(testPath)
          } else {
            throw new Error('path is invalid')
          }
          if(!(await this.getAllFiles('**/*', {cwd: dirPath, strict: false, nodir: true})).length){
            await fs.remove(folderPath)
            throw new Error('torrent can not be empty')
          }
          const testData = await this.echoHash(info.infohash, folderPath, dirPath)
          return {id: info.infohash, ...testData, activeTorrent}
        }
      }
    } else if((info.address && info.secret) || info.title){
      info = info.title ? this.createKeypair(info.title) : info

      if(this.checkId.has(info.address)){
        this.checkId.delete(info.address)
      }
      const activeTorrent = await this.handleTheData({ id: info.address, num: useTimeout, kind: 'stop', res: false }, this.stopTorrent(info.address, { destroyStore: false }), null)

      const authorPath = path.join(this._author, info.address)
      if(await fs.pathExists(authorPath)){
        const authorStuff = JSON.parse((await fs.readFile(authorPath)).toString()) 
        const folderPath = path.join(this._storage, authorStuff.dir)
        const descriptionPath = path.join(this._description, authorStuff.dir)
        const dataPath = path.join(folderPath, pathToData)
  
        if(!await fs.pathExists(folderPath)){
          throw new Error('did not find any torrent data to delete')
        }
  
        if (pathToData === '/') {
          
          await fs.remove(authorPath)
          await fs.remove(folderPath)
          await fs.remove(descriptionPath)

          return {id: info.address, path: pathToData, address: info.address, activeTorrent}
        } else {
          if(!info.secret){
            throw new Error('secret key is request')
          }
          if(await fs.pathExists(dataPath)){
            await fs.remove(dataPath)
            if(!(await this.getAllFiles('**/*', {cwd: folderPath, strict: false, nodir: true})).length){
              await fs.remove(authorPath)
              await fs.remove(folderPath)
              await fs.remove(descriptionPath)
              throw new Error('torrent can not be empty')
            }
          } else {
            throw new Error('path is invalid')
          }
          const useOpts = descriptionPath ? await (async () => {if(await fs.pathExists(descriptionPath)){const test = await fs.readFile(descriptionPath);return JSON.parse(test.toString());}else{return {};}})() : {}
  
          const dataFromFolder = await (async () => {
            try {
              return await this.dataFromTorrent(folderPath, useOpts)
            } catch (err) {
              await fs.remove(authorPath)
              await fs.remove(folderPath)
              await fs.remove(descriptionPath)
              throw err
            }
          })()

          const obj = {...authorStuff.stuff, ih: dataFromFolder.infoHash}

          const dataFromProp = await this.publishFunc(info.address, info.secret, obj, authorStuff.sequence + 1)
  
          await fs.writeFile(authorPath, JSON.stringify(dataFromProp))
  
          return {id: info.address, path: pathToData, address: authorStuff.address, activeTorrent}
        }
      } else {
        const folderPath = path.join(this._storage, info.address)
  
        if(!await fs.pathExists(folderPath)){
          throw new Error('did not find any torrent data to delete')
        }
  
        if(pathToData === '/'){
  
          await fs.remove(folderPath)

          return {id: info.address, path: pathToData, address: info.address, activeTorrent}
        } else {
          const mainPath = path.join(folderPath, 'nfo.txt')
          const dirPath = path.join(folderPath, (await fs.readFile(mainPath)).toString())
          const namePath = path.join(dirPath, 'nfo.txt')
          const dataPath = path.join(dirPath, (await fs.readFile(namePath)).toString())
          let wasItFound = null
          const testPath = path.join(dataPath, pathToData)
          if (await fs.pathExists(testPath)) {
            await fs.remove(testPath)
          } else {
            throw new Error('path is invalid')
          }
          if(!(await this.getAllFiles('**/*', {cwd: dataPath, strict: false, nodir: true})).length){
            await fs.remove(folderPath)
            throw new Error('torrent can not be empty')
          }
          const testData = await this.echoAddress(info.address, folderPath, dataPath)
          return {id: info.address, path: pathToData, ...testData, activeTorrent}
        }
      }
    } else {
      throw new Error('data is invalid')
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
  async echoAddress(id, folderPath, mainPath){
    const dir = uid(20)
    const dirPath = path.join(this._storage, dir)
    await fs.ensureDir(dirPath)
    await fs.copy(mainPath, dirPath, {overwrite: true})
    await fs.remove(folderPath)
    const descripPath = path.join(this._description, dir)
    await fs.writeFile(descripPath, JSON.stringify({}))
    const dataFromDir = await this.dataFromTorrent(dirPath, {})
    const pairID = this.createKeypair(null)
    const pubTorrentData = await this.publishFunc(pairID.address, pairID.secret, {ih: dataFromDir.infoHash}, 0)
    pubTorrentData.dir = dir
    pubTorrentData.echo = id
    const authorPath = path.join(this._author, pubTorrentData.address)
    await fs.writeFile(authorPath, JSON.stringify(pubTorrentData))
    return pubTorrentData
  }
  async echoHash(id, folderPath, movePath){
    // const mainArr = await fs.readdir(folderPath, {withFileTypes: true})
    const dir = uid(20)
    const dirPath = path.join(this._storage, dir)
    await fs.ensureDir(dirPath)
    await fs.copy(movePath, dirPath, { overwrite: true })
    await fs.remove(folderPath)
    const descripPath = path.join(this._description, dir)
    await fs.writeFile(descripPath, JSON.stringify({}))
    const dataFromDir = await this.dataFromTorrent(dirPath, {})
    const pubTorrentData = {infohash: dataFromDir.infoHash, dir: dir, echo: id}
    const authorPath = path.join(this._author, pubTorrentData.infohash)
    await fs.writeFile(authorPath, JSON.stringify(pubTorrentData))
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
        resolve(torrent)
      })
    })
  }
  startTorrent(folder, opts){
    return new Promise((resolve, reject) => {
      this.webtorrent.seed(folder, opts, torrent => {
        resolve(torrent)
      })
    })
  }
  stopTorrent(dataForTorrent, opts) {
    return new Promise((resolve, reject) => {
        const getTorrent = this.findTheTorrent(dataForTorrent)
        if (getTorrent) {
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
      if(torrent.address === id || torrent.infohash === id){
        data = torrent
        break
      }
    }
    return data
  }

  async handleFormData(folderPath, data, sec) {
    if (!await fs.pathExists(folderPath)) {
      await fs.ensureDir(folderPath)
    }
    const saved = []
    for (const info of data) {
      const tempPath = path.join(folderPath, info.name)
      await this.handleTheData({ id: tempPath, num: sec, res: false, kind: 'formdata' }, pipelinePromise(Readable.from(info.stream()), fs.createWriteStream(tempPath)), null)
      saved.push(tempPath)
    }
    return saved
  }

  async handleRegData(mainPath, body, sec) {
    const checkDir = path.dirname(mainPath)
    if (!await fs.pathExists(mainPath)) {
      await fs.ensureDir(checkDir)
    }
    await this.handleTheData({ id: mainPath, num: sec, res: false, kind: 'regdata' }, pipelinePromise(Readable.from(body), fs.createWriteStream(mainPath)), null)
    return [mainPath]
  }

  // -------------- the below functions are BEP46 helpers ----------------

  // keep the data we currently hold active by putting it back into the dht
  saveData (data) {
    return new Promise((resolve, reject) => {
      this.webtorrent.dht.put({ k: Buffer.from(data.address, 'hex'), v: { ih: Buffer.from(data.infohash || data.infoHash, 'hex'), ...this.stuffToBuff(data.stuff) }, seq: data.sequence, sig: Buffer.from(data.sig, 'hex') }, (error, hash, number) => {
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
    const title = data ? Buffer.from(data, 'hex') : ed.createSeed()
    const { publicKey, secretKey } = ed.createKeyPair(title)
    return { address: publicKey.toString('hex'), secret: secretKey.toString('hex'), title: title.toString('hex') }
  }

  // obj to buff for stuff
  stuffToBuff(data){
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
  async authorData(){
    return await fs.readdir(this._author, {withFileTypes: false})
  }
  async torrentData(data) {
    const authorData = new Set()
    const listFiles = await fs.readdir(this._author, {withFileTypes: false})
    const parseFiles = []
    for(const test of listFiles){
      const parseTest = JSON.parse((await fs.readFile(path.join(this._author, test))).toString())
      authorData.add(parseTest.dir)
      parseFiles.push({address: parseTest.address, infohash: parseTest.infohash, dir: parseTest.dir})
    }
    const dirFiles = await fs.readdir(this._storage, {withFileTypes: false})
    for(const iter of dirFiles){
      if(iter.length === 64){
        parseFiles.push({address: iter})
      } else if (iter.length === 40) {
        parseFiles.push({ infohash: iter })
      } else if (iter.length === 20 && !authorData.has(iter)) {
        await fs.remove(path.join(this._storage, iter))
      }
    }
    return data ? parseFiles : parseFiles.map((data) => {if (data.address) {return data.address} else {return data.infohash}})
  }
}

module.exports = Torrentz

/* 
comments
*/