const WebTorrent = require('webtorrent')
const fs = require('fs-extra')
const path = require('path')
const sha1 = require('simple-sha1')
const ed = require('ed25519-supercop')
const bencode = require('bencode')
// const streamx = require('streamx')
// const { Readable } = require('stream')
const { pipelinePromise, Readable } = require('streamx')
const wrtc = require('wrtc')
const createTorrent = require('create-torrent')
const parseTorrent = require('parse-torrent')
const {uid} = require('uid')
// const fsp = require('fs/promises')
const glob = require("glob")
const crypto = require('crypto')
const derive = require('derive-key')

// saves us from saving secret keys(saving secret keys even encrypted secret keys is something i want to avoid)
// with this function which was taken from the bittorrent-dht package
// we save only the signatures when we first publish a BEP46 torrent

class Torrentz {
  constructor (opts = {}) {
    const defOpts = { folder: __dirname, storage: 'storage', author: 'author', description: 'description', user: 'user', timeout: 60000, routine: 3600000 }
    const finalOpts = { ...defOpts, ...opts }
    this._timeout = finalOpts.timeout
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
    const useId = torrent.infohash || torrent.address || this.createKeypair(torrent.title).address
    const torrentStuff = await this.loadTorrent(torrent, pathToData)
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

  errName(err, text){
    err.name = text
    return err
  }

  delayTimeOut (timeout, data, res = false) {
    return new Promise((resolve, reject) => { setTimeout(() => { if (res) { resolve(data) } else { reject(data) } }, timeout) })
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
      await this.stopTorrent(activeTorrent.infoHash, {destroyStore: false})
    }
  }

  async loadTorrent(id, pathToData, opts = {}){
    if(!opts){
      opts = {}
    }

    const useTimeout = opts.timeout ? opts.timeout * 1000 : this._timeout

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
        const checkTorrent = await Promise.race([
          this.delayTimeOut(useTimeout, this.errName(new Error(id.infohash + ' took too long, it timed out'), 'ErrorTimeout'), false),
          this.startTorrent(folderPath, { ...useOpts, destroyStoreOnDestroy: false })
        ])
        if(checkTorrent.infoHash !== authorStuff.infohash){
          try {
            this.webtorrent.remove(checkTorrent.infoHash, { destroyStore: false }) 
          } catch (error) {
            console.error(error)
          }
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
        const checkTorrent = await Promise.race([
          this.delayTimeOut(useTimeout, this.errName(new Error(id.infohash + ' took too long, it timed out'), 'ErrorTimeout'), false),
          this.midTorrent(id.infohash, { path: folderPath, destroyStoreOnDestroy: false })
        ]).catch(err => {
          try {
            const haveIt = this.findTheTorrent(id.infohash)
            if(haveIt){
              this.webtorrent.remove(haveIt.infoHash, { destroyStore: false })
            }
          } catch (error) {
            console.error(error)
          }
          throw err
        })
        // const mainPath = path.join(checkTorrent.path, checkTorrent.name)
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

        const checkTorrent = await Promise.race([
          this.delayTimeOut(useTimeout, this.errName(new Error(id.address + ' took too long, it timed out'), 'ErrorTimeout'), false),
          this.startTorrent(folderPath, { ...useOpts, destroyStoreOnDestroy: true })
        ])
        if(checkTorrent.infoHash !== authorStuff.infohash){
          try {
            this.webtorrent.remove(checkTorrent.infoHash, { destroyStore: false }) 
          } catch (error) {
            console.error(error)
          }
          throw new Error('infohash does not match with the given infohash')
        }
        const checkProperty = await Promise.race([
          this.delayTimeOut(this._timeout, this.errName(new Error(id.address + ' property took too long, it timed out, please try again with only the keypair without the folder'), 'ErrorTimeout'), false),
          this.ownData(authorStuff, checkTorrent.infoHash)
        ]).catch(err => {
          try {
            this.webtorrent.remove(checkTorrent.infoHash, { destroyStore: false }) 
          } catch (error) {
            console.error(error)
          }
          throw err
        })
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
        const checkProperty = await Promise.race([
          this.delayTimeOut(this._timeout, this.errName(new Error(id.address + ' property took too long, it timed out'), 'ErrorTimeout'), false),
          this.resolveFunc(id.address)
        ])
    
        checkProperty.folder = folderPath
        const dataPath = path.join(checkProperty.folder, checkProperty.infohash)

        if (!await fs.pathExists(dataPath)) {
          await fs.emptyDir(checkProperty.folder)
          await fs.writeFile(path.join(checkProperty.folder, 'info.txt'), checkProperty.infohash)
        }
    
        const checkTorrent = await Promise.race([
          this.delayTimeOut(useTimeout, this.errName(new Error(checkProperty.address + ' took too long, it timed out'), 'ErrorTimeout'), false),
          this.midTorrent(checkProperty.infohash, { path: dataPath, destroyStoreOnDestroy: false })
        ]).catch(err => {
          try {
            const haveIt = this.findTheTorrent(checkProperty.infohash)
            if(haveIt){
              this.webtorrent.remove(haveIt.infoHash, { destroyStore: false }) 
            }
          } catch (error) {
            console.error(error)
          }
          throw err
        })
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
    const useTimeout = opts.timeout ? opts.timeout * 1000 : this._timeout
    if(id.infohash || id.infohash === null){

      id = id.infohash ? await (async () => {if(this.checkId.has(id.infohash)){this.checkId.delete(id.infohash)}const activeTorrent = this.findTheTorrent(id.infohash);if(activeTorrent){await this.stopTorrent(activeTorrent.infoHash, {destroyStore: false})};return JSON.parse((await fs.readFile(path.join(this._author, id.infohash))).toString());})() : {infohash: null, dir: uid(20)}
      
      const folderPath = path.join(this._storage, id.dir)

      await fs.ensureDir(folderPath)
      
      const dataPath = path.join(folderPath, pathToData)
      const descriptionPath = path.join(this._description, id.dir)
      const useOpts = await (async () => {if(opts.opt){await fs.writeFile(descriptionPath, JSON.stringify(opts.opt));return opts.opt;}else if(await fs.pathExists(descriptionPath)){const test = await fs.readFile(descriptionPath);return JSON.parse(test.toString());}else{return {};}})()
      // const useOpts = await (async () => {if(await fs.pathExists(descriptionPath)){const test = await fs.readFile(descriptionPath);return JSON.parse(test.toString());}else if(opts.opt){await fs.writeFile(descriptionPath, JSON.stringify(opts.opt));return opts.opt;}else{return {};}})()
      
      const saved = Array.isArray(data) ? await this.handleFormData(dataPath, data, useTimeout) : await this.handleRegData(dataPath, data, useTimeout)
      const extraFile = path.join(folderPath, `${id.dir}.json`)
      if (await fs.pathExists(extraFile)) {
        const extraData = JSON.parse((await fs.readFile(extraFile)).toString())
        extraData.neta = extraData.neta + 1
        await fs.writeFile(extraFile, JSON.stringify(extraData))
      } else {
        await fs.writeFile(extraFile, JSON.stringify({neta: 0}))
      }

      const checkTorrent = await Promise.race([
        this.delayTimeOut(useTimeout, this.errName(new Error('torrent took too long, it timed out'), 'ErrorTimeout'), false),
        this.dataFromTorrent(folderPath, useOpts)
      ])

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
        const extraFile = path.join(folderPath, `${authorStuff.dir}.json`)
        if (await fs.pathExists(extraFile)) {
          const extraData = JSON.parse((await fs.readFile(extraFile)).toString())
          extraData.neta = extraData.neta + 1
          await fs.writeFile(extraFile, JSON.stringify(extraData))
        } else {
          await fs.writeFile(extraFile, JSON.stringify({neta: 0}))
        }
  
        const checkTorrent = await Promise.race([
          this.delayTimeOut(useTimeout, this.errName(new Error('torrent took too long, it timed out'), 'ErrorTimeout'), false),
          this.dataFromTorrent(folderPath, useOpts)
          // this.startTorrent(folderPath, { ...useOpts, destroyStoreOnDestroy: false })
        ])
        const checkProperty = await Promise.race([
          this.delayTimeOut(this._timeout, this.errName(new Error(id.address + ' property took too long, it timed out, please try again with only the keypair without the folder'), 'ErrorTimeout'), false),
          this.publishFunc(authorStuff.address, id.secret, { ih: checkTorrent.infoHash }, opts.count ? opts.count : authorStuff.sequence + 1)
        ])
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
        const extraFile = path.join(folderPath, `${dir}.json`)
        if (await fs.pathExists(extraFile)) {
          const extraData = JSON.parse((await fs.readFile(extraFile)).toString())
          extraData.neta = extraData.neta + 1
          await fs.writeFile(extraFile, JSON.stringify(extraData))
        } else {
          await fs.writeFile(extraFile, JSON.stringify({neta: 0}))
        }
  
        const checkTorrent = await Promise.race([
          this.delayTimeOut(useTimeout, this.errName(new Error('torrent took too long, it timed out'), 'ErrorTimeout'), false),
          this.dataFromTorrent(folderPath, useOpts)
          // this.startTorrent(folderPath, { ...useOpts, destroyStoreOnDestroy: false })
        ])
        const checkProperty = await Promise.race([
          this.delayTimeOut(this._timeout, this.errName(new Error(id.address + ' property took too long, it timed out, please try again with only the keypair without the folder'), 'ErrorTimeout'), false),
          this.publishFunc(id.address, id.secret, { ih: checkTorrent.infoHash }, opts.count ? opts.count : 0)
        ])
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

    const useTimeout = opts.timeout ? opts.timeout * 1000 : this._timeout

    if(info.infohash){
      if(this.checkId.has(info.infohash)){
        this.checkId.delete(info.infohash)
      }
  
      const activeTorrent = this.findTheTorrent(info.infohash)
      if(activeTorrent){
        await Promise.race([
          this.stopTorrent(activeTorrent.infoHash, {destroyStore: false}),
          this.delayTimeOut(useTimeout, this.errName(new Error('did not remove in time'), 'ErrorTimeout'), false)
        ])
      }
      const authorPath = path.join(this._author, info.infohash)
      if(await fs.pathExists(authorPath)){
        const authorStuff = JSON.parse((await fs.readFile(authorPath)).toString()) 
        const folderPath = path.join(this._storage, authorStuff.dir)
        const descriptionPath = path.join(this._description, authorStuff.dir)
        const dataPath = path.join(folderPath, pathToData)
  
        if(!await fs.pathExists(folderPath)){
          throw new Error('did not find any torrent data to delete')
        }
  
        if(pathToData === '/'){
          if(await fs.pathExists(authorPath)){
            await fs.remove(authorPath)
          }
  
          await fs.remove(folderPath)
    
          if(await fs.pathExists(descriptionPath)){
            await fs.remove(descriptionPath)
          }
          return {id: info.infohash, path: pathToData, infohash: info.infohash}
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

          return {id: info.infohash, path: pathToData, infohash: dataFromFolder.infoHash}
        }
      } else {
        const folderPath = path.join(this._storage, info.infohash)
        const descriptionPath = path.join(this._description, info.infohash)
        // const dataPath = path.join(folderPath, pathToData)
  
        if(!await fs.pathExists(folderPath)){
          throw new Error('did not find any torrent data to delete')
        }
  
        if(pathToData === '/'){
  
          await fs.remove(folderPath)
    
          if(await fs.pathExists(descriptionPath)){
            await fs.remove(descriptionPath)
          }
          return {id: info.infohash, path: pathToData, infohash: info.infohash}
        } else {
          let wasItFound = null
          const dirPath = await fs.readdir(folderPath, {withFileTypes: true})
          for(const test of dirPath){
            if(test.isDirectory()){
              const testPath = path.join(folderPath, test.name, pathToData)
              if(await fs.pathExists(testPath)){
                wasItFound = testPath
                break
              }
            }
            if(test.isFile()){
              const testPath = path.join(folderPath, pathToData)
              const otherPath = path.join(folderPath, test.name)
              if(testPath === otherPath){
                wasItFound = testPath
                break
              }
            }
          }
          if(wasItFound){
            await fs.remove(wasItFound)
            if(!(await this.getAllFiles('**/*', {cwd: folderPath, strict: false, nodir: true})).length){
              await fs.remove(folderPath)
              await fs.remove(descriptionPath)
              throw new Error('torrent can not be empty')
            }
            const testData = await this.echoHash(info.infohash, folderPath)
            return {id: info.infohash, ...testData}
          } else {
            throw new Error('did not find the path')
          }
          // throw new Error('Must be creator to delete any files or directories inside the torrent')
        }
      }
    } else if((info.address && info.secret) || info.title){
      info = info.title ? this.createKeypair(info.title) : info
      const authorPath = path.join(this._author, info.address)
      if(await fs.pathExists(authorPath)){
        const authorStuff = JSON.parse((await fs.readFile(authorPath)).toString()) 
        const folderPath = path.join(this._storage, authorStuff.dir)
        const descriptionPath = path.join(this._description, authorStuff.dir)
        const dataPath = path.join(folderPath, pathToData)
  
        if(!await fs.pathExists(folderPath)){
          throw new Error('did not find any torrent data to delete')
        }
  
        if(pathToData === '/'){
          if(await fs.pathExists(authorPath)){
            await fs.remove(authorPath)
          }
  
          await fs.remove(folderPath)
    
          if(await fs.pathExists(descriptionPath)){
            await fs.remove(descriptionPath)
          }
          return {id: info.address, path: pathToData, address: info.address}
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
            throw new Error('path is not valid')
          }
          const useOpts = descriptionPath ? await (async () => {if(await fs.pathExists(descriptionPath)){const test = await fs.readFile(descriptionPath);return JSON.parse(test.toString());}else{return {};}})() : {}
  
          const dataFromFolder = await (async () => {
            try {
              return await this.dataFromTorrent(folderPath, useOpts)
            } catch (err) {
              if(authorStuff){
                await fs.remove(authorPath)
              }
              await fs.remove(folderPath)
        
              if(await fs.pathExists(descriptionPath)){
                await fs.remove(descriptionPath)
              }
              throw err
            }
          })()

          const obj = {...authorStuff.stuff, ih: dataFromFolder.infoHash}

          const dataFromProp = await this.publishFunc(info.address, info.secret, obj, authorStuff.sequence + 1)
  
          await fs.writeFile(authorPath, JSON.stringify(dataFromProp))
  
          return {id: info.address, path: pathToData, address: authorStuff.address}
        }
      } else {
        const folderPath = path.join(this._storage, info.address)
        const descriptionPath = path.join(this._description, info.address)
        // const dataPath = path.join(folderPath, pathToData)
  
        if(!await fs.pathExists(folderPath)){
          throw new Error('did not find any torrent data to delete')
        }
  
        if(pathToData === '/'){
  
          await fs.remove(folderPath)
    
          if(await fs.pathExists(descriptionPath)){
            await fs.remove(descriptionPath)
          }
          return {id: info.address, path: pathToData, address: info.address}
        } else {
          const mainPath = path.join(folderPath, 'info.txt')
          const dataPath = path.join(folderPath, (await fs.readFile(mainPath)).toString())
          let wasItFound = null
          const dirPath = await fs.readdir(dataPath, {withFileTypes: true})
          for(const test of dirPath){
            if(test.isDirectory()){
              const testPath = path.join(dataPath, test.name, pathToData)
              if(await fs.pathExists(testPath)){
                wasItFound = testPath
                break
              }
            }
            if(test.isFile()){
              const testPath = path.join(dataPath, pathToData)
              const otherPath = path.join(dataPath, test.name)
              if(testPath === otherPath){
                wasItFound = testPath
                break
              }
            }
          }
          if(wasItFound){
            await fs.remove(wasItFound)
            if(!(await this.getAllFiles('**/*', {cwd: dataPath, strict: false, nodir: true})).length){
              await fs.remove(folderPath)
              await fs.remove(descriptionPath)
              throw new Error('torrent can not be empty')
            }
            const testData = await this.echoAddress(info.address, folderPath)
            return {id: info.address, path: pathToData, ...testData}
          } else {
            throw new Error('did not find the path')
          }
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
  async echoAddress(id, folderPath){
    const infoPath = path.join(folderPath, 'info.txt')
    const mainPath = path.join(folderPath, (await fs.readFile(infoPath)).toString())
    const mainArr = await fs.readdir(mainPath, {withFileTypes: true})
    const dir = uid(20)
    const dirPath = path.join(this._storage, dir)
    await fs.ensureDir(dirPath)
    for(const test of mainArr){
      if(test.isDirectory()){
        const dataPath = path.join(mainPath, test.name)
        await fs.copy(dataPath, dirPath, {overwrite: true})
      }
      if(test.isFile()){
        const dataPath = path.join(mainPath, test.name)
        const finalPath = path.join(dirPath, test.name)
        await fs.copy(dataPath, finalPath, {overwrite: true})
      }
    }
    try {
      await fs.remove(folderPath)
    } catch (err) {
      await fs.remove(dirPath)
      throw err
    }
    const descripPath = path.join(this._description, dir)
    await fs.writeFile(descripPath, JSON.stringify({}))
    const dataFromDir = await this.dataFromTorrent(dirPath, {})
    const pairID = this.createKeypair(null)
    const pubTorrentData = await this.publishFunc(pairID.address, pairID.secret, {ih: dataFromDir.infoHash}, 0)
    pubTorrentData.dir = dir
    pubTorrentData.echo = id
    const authorPath = path.join(this._author, pairID.address)
    await fs.writeFile(authorPath, JSON.stringify(pubTorrentData))
    return pairID
  }
  async echoHash(id, folderPath){
    const mainArr = await fs.readdir(folderPath, {withFileTypes: true})
    const dir = uid(20)
    const dirPath = path.join(this._storage, dir)
    await fs.ensureDir(dirPath)
    for(const test of mainArr){
      if(test.isDirectory()){
        const dataPath = path.join(folderPath, test.name)
        await fs.copy(dataPath, dirPath, {overwrite: true})
      }
      if(test.isFile()){
        const dataPath = path.join(folderPath, test.name)
        const finalPath = path.join(dirPath, test.name)
        await fs.copy(dataPath, finalPath, {overwrite: true})
      }
    }
    try {
      await fs.remove(folderPath)
    } catch (err) {
      await fs.remove(dirPath)
      throw err
    }
    const descripPath = path.join(this._description, dir)
    await fs.writeFile(descripPath, JSON.stringify({}))
    const dataFromDir = await this.dataFromTorrent(dirPath, {})
    const pubTorrentData = {infohash: dataFromDir.infoHash, dir: dir, echo: id}
    const authorPath = path.join(this._author, dataFromDir.infoHash)
    await fs.writeFile(authorPath, JSON.stringify(pubTorrentData))
    return {infohash: dataFromDir.infoHash}
  }
  async echoTorrent(id, opts = {}){
    if(!opts){
      opts = {}
    }

    const useTimeout = opts.timeout ? opts.timeout * 1000 : this._timeout
    const torrentData = {}
    
    if(id.infohash){
      const folderPath = path.join(this._storage, id.infohash)
      if(await fs.pathExists(folderPath)){
        const testData = await this.echoHash(id.infohash, folderPath)
        return {id: id.infohash, infohash: testData.infohash}
      } else {
        await fs.ensureDir(folderPath)
        const checkTorrent = await Promise.race([
          this.delayTimeOut(useTimeout, this.errName(new Error(checkProperty.address + ' took too long, it timed out'), 'ErrorTimeout'), false),
          this.midTorrent(id, { path: folderPath, destroyStoreOnDestroy: false })
        ]).catch(async (err) => {
          try {
            const haveIt = this.findTheTorrent(id.infohash)
            if(haveIt){
              this.webtorrent.remove(haveIt.infoHash, { destroyStore: false }) 
            }
          } catch (error) {
            console.error(error)
          }
          await fs.remove(folderPath)
          throw err
        })
        await Promise.race([
          this.stopTorrent(checkTorrent.infoHash, {destroyStore: false}),
          this.delayTimeOut(useTimeout, this.errName(new Error('did not remove in time'), 'ErrorTimeout'), false)
        ])
        const testData = await this.echoHash(id.infohash, folderPath)
        return {id: id.infohash, infohash: testData.infohash}
      }
    } else if(id.address){
      const folderPath = path.join(this._storage, id.address)
      if(await fs.pathExists(folderPath)){
        const testData = await this.echoAddress(id.address, folderPath)
        return {id: id.address, ...testData}
      } else {
        // await fs.ensureDir(folderPath)
        const checkProperty = await Promise.race([
          this.delayTimeOut(this._timeout, this.errName(new Error(id.address + ' property took too long, it timed out'), 'ErrorTimeout'), false),
          this.resolveFunc(id.address)
        ])
        const dataPath = path.join(folderPath, checkProperty.infohash)
        await fs.ensureDir(dataPath)
        const infoPath = path.join(folderPath, 'info.txt')
        await fs.writeFile(infoPath, JSON.stringify(checkProperty.infohash))
        const checkTorrent = await Promise.race([
          this.delayTimeOut(useTimeout, this.errName(new Error(checkProperty.address + ' took too long, it timed out'), 'ErrorTimeout'), false),
          this.midTorrent(checkProperty.infohash, { path: dataPath, destroyStoreOnDestroy: false })
        ]).catch(async (err) => {
          try {
            const haveIt = this.findTheTorrent(checkProperty.infohash)
            if(haveIt){
              this.webtorrent.remove(haveIt.infoHash, { destroyStore: false }) 
            }
          } catch (error) {
            console.error(error)
          }
          await fs.remove(folderPath)
          throw err
        })
        await Promise.race([
          this.stopTorrent(checkTorrent.infoHash, {destroyStore: false}),
          this.delayTimeOut(useTimeout, this.errName(new Error('did not remove in time'), 'ErrorTimeout'), false)
        ])
        const testData = await this.echoAddress(id.address, folderPath)
        torrentData.address = testData.address
        torrentData.secret = testData.secret
        torrentData.title = testData.title
        return {id: id.address, ...testData}
      }
    } else {
      throw new Error('id is not valid')
    }
  }
  async unEchoTorrent(id, opts = {}){
    if(!opts){
      opts = {}
    }
    const useTimeout = opts.timeout ? opts.timeout * 1000 : this._timeout
    
    if(id.infohash){
      const authorPath = path.join(this._author, id.infohash)
      if(await fs.pathExists(authorPath)){
        const authorStuff = JSON.parse((await fs.readFile(authorPath)).toString())
        await fs.remove(authorPath)
        const folderPath = path.join(this._storage, authorStuff.dir)
        if(await fs.pathExists(folderPath)){
          await fs.remove(folderPath)
          const descripPath = path.join(this._description, authorStuff.dir)
          if(await fs.pathExists(descripPath)){
            await fs.remove(descripPath)
          }
        const echoPath = path.join(this._storage, authorStuff.echo)
        await fs.ensureDir(echoPath)
        const checkTorrent = await Promise.race([
          this.delayTimeOut(useTimeout, this.errName(new Error(checkProperty.address + ' took too long, it timed out'), 'ErrorTimeout'), false),
          this.midTorrent(authorStuff.echo, { path: echoPath, destroyStoreOnDestroy: false })
        ]).catch(async (err) => {
          try {
            const haveIt = this.findTheTorrent(checkProperty.infohash)
            if(haveIt){
              this.webtorrent.remove(haveIt.infoHash, { destroyStore: false }) 
            }
          } catch (error) {
            console.error(error)
          }
          await fs.remove(echoPath)
          throw err
        })
        await Promise.race([
          this.stopTorrent(checkTorrent.infoHash, {destroyStore: false}),
          this.delayTimeOut(useTimeout, this.errName(new Error('did not remove in time'), 'ErrorTimeout'), false)
        ])
        return {id: id.infohash, infohash: authorStuff.echo}
        } else {
          throw new Error('did not find the folder')
        }
      } else {
        throw new Error('did not find the echo')
      }
    } else if(id.address){
      const authorPath = path.join(this._author, id.address)
      if(await fs.pathExists(authorPath)){
        const authorStuff = JSON.parse((await fs.readFile(authorPath)).toString())
        await fs.remove(authorPath)
        const folderPath = path.join(this._storage, authorStuff.dir)
        if(await fs.pathExists(folderPath)){
          await fs.remove(folderPath)
          const descripPath = path.join(this._description, authorStuff.dir)
          if(await fs.pathExists(descripPath)){
            await fs.remove(descripPath)
          }
        const checkProperty = await Promise.race([
          this.delayTimeOut(this._timeout, this.errName(new Error(authorStuff.echo + ' property took too long, it timed out'), 'ErrorTimeout'), false),
          this.resolveFunc(authorStuff.echo)
        ])
        const echoPath = path.join(this._storage, checkProperty.address)
        const dataPath = path.join(echoPath, checkProperty.infohash)
        await fs.ensureDir(dataPath)
        const infoPath = path.join(echoPath, 'info.txt')
        await fs.writeFile(infoPath, JSON.stringify(checkProperty.infohash))
        const checkTorrent = await Promise.race([
          this.delayTimeOut(useTimeout, this.errName(new Error(checkProperty.address + ' took too long, it timed out'), 'ErrorTimeout'), false),
          this.midTorrent(checkProperty.infohash, { path: dataPath, destroyStoreOnDestroy: false })
        ]).catch(async (err) => {
          try {
            const haveIt = this.findTheTorrent(checkProperty.infohash)
            if(haveIt){
              this.webtorrent.remove(haveIt.infoHash, { destroyStore: false }) 
            }
          } catch (error) {
            console.error(error)
          }
          await fs.remove(echoPath)
          throw err
        })
        await Promise.race([
          this.stopTorrent(checkTorrent.infoHash, {destroyStore: false}),
          this.delayTimeOut(useTimeout, this.errName(new Error('did not remove in time'), 'ErrorTimeout'), false)
        ])
        return {id: id.address, address: checkProperty.address}
        } else {
          throw new Error('did not find the folder')
        }
      } else {
        throw new Error('did not find the echo')
      }
    } else {
      throw new Error('id is not valid')
    }
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
  stopTorrent(infohash, opts){
    return new Promise((resolve, reject) => {
      this.webtorrent.remove(infohash, opts, (error) => {
        if(error){
          reject(error)
        } else {
          resolve()
        }
      })
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
    const iter = []
    for (const info of data) {
        const tempPath = path.join(folderPath, info.name)
        saved.push(tempPath)
        iter.push(
          Promise.race([
            pipelinePromise(Readable.from(info.stream()), fs.createWriteStream(tempPath)),
            new Promise((resolve, reject) => setTimeout(reject, sec))
          ])
        )
    }
    await Promise.all(iter)
    return saved
  }

  async handleRegData(folderPath, body, sec) {
    const checkDir = path.dirname(folderPath)
    if (!await fs.pathExists(folderPath)) {
      await fs.ensureDir(checkDir)
    }
    await Promise.race([
      pipelinePromise(Readable.from(body), fs.createWriteStream(folderPath)),
      new Promise((resolve, reject) => setTimeout(reject, sec))
    ])
    return [folderPath]
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
    // const title = data ? data : uid(16)
    // const { publicKey, secretKey } = ed.createKeyPair(Buffer.from(crypto.createHash('sha256').update(title).digest('hex'), 'hex'))
    const title = data ? data : uid(16)
    const seed = derive(this._name, this.seedData, title)
    const { publicKey, secretKey } = ed.createKeyPair(seed)
    return { address: publicKey.toString('hex'), secret: secretKey.toString('hex'), title: title }
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