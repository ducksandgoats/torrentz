const WebTorrent = require('webtorrent')
const fs = require('fs-extra')
const path = require('path')
const sha1 = require('simple-sha1')
const ed = require('ed25519-supercop')
const bencode = require('bencode')
const busboy = require('busboy')
const { Readable } = require('stream')
const wrtc = require('wrtc')
const createTorrent = require('create-torrent')
const parseTorrent = require('parse-torrent')
const {uid} = require('uid')

// saves us from saving secret keys(saving secret keys even encrypted secret keys is something i want to avoid)
// with this function which was taken from the bittorrent-dht package
// we save only the signatures when we first publish a BEP46 torrent

class Torrentz {
  constructor (opts = {}) {
    const defOpts = { folder: __dirname, storage: 'storage', author: 'author', description: 'description', current: true, timeout: 60000, routine: 3600000 }
    const finalOpts = { ...defOpts, ...opts }
    this._timeout = finalOpts.timeout
    this._routine = finalOpts.routine
    this.checkHash = /^[a-fA-F0-9]{40}$/
    this.checkAddress = /^[a-fA-F0-9]{64}$/
    this.checkTitle = /^[a-zA-Z0-9]/

    finalOpts.folder = path.resolve(finalOpts.folder)
    fs.ensureDirSync(finalOpts.folder)

    this._current = finalOpts.current
    this._folder = finalOpts.folder
    this._storage = path.join(this._folder, finalOpts.storage)
    this._author = path.join(this._folder, finalOpts.author)
    this._description = path.join(this._folder, finalOpts.description)
    if (!fs.pathExistsSync(this._storage)) {
      fs.ensureDirSync(this._storage)
    }
    if (!fs.pathExistsSync(this._author)) {
      fs.ensureDirSync(this._author)
    }
    if (!fs.pathExistsSync(this._description)) {
      fs.ensureDirSync(this._description)
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
  async ownData (address, infoHash) {
    const authorPath = path.join(this._author, address)
    if (!await fs.pathExists(authorPath)) {
      throw new Error('data was not found')
    }
    // get data from file
    let data = await fs.readFile(authorPath)
    // parse the data file
    data = JSON.parse(data.toString())

    if(infoHash !== data.infohash){
      throw new Error('infohash does not match with the given infohash')
    }

    const hashBuff = Buffer.from(infoHash, 'hex')
    const signatureBuff = Buffer.from(data.sig, 'hex')
    const encodedSignatureData = this.encodeSigData({ seq: data.sequence, v: { ih: hashBuff, ...data.stuff } })
    const addressBuff = Buffer.from(data.address, 'hex')

    if (!ed.verify(signatureBuff, encodedSignatureData, addressBuff)) {
      throw new Error('data does not match signature')
    }

    const putData = await new Promise((resolve, reject) => {
      this.webtorrent.dht.put({ k: addressBuff, v: {ih: hashBuff, ...data.stuff}, seq: data.sequence, sig: signatureBuff }, (putErr, hash, number) => {
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

    let main = null
    let seq = null
    const authorPath = path.join(this._author, address)
    if (await fs.pathExists(authorPath)) {
      main = await fs.readFile(authorPath)
      main = JSON.parse(main.toString())
      seq = main.sequence + 1
    } else {
      seq = count ? count : 0
    }

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
    main = { magnet: `magnet:?xs=${this.BTPK_PREFIX}${address}`, address, infohash: ih, sequence: seq, stuff, sig: buffSig.toString('hex'), ...putData }
    await fs.writeFile(authorPath, JSON.stringify(main))
    return main
  }

  async loadTorrent(id, pathToData, opts = {}){
    if(!opts){
      opts = {}
    }
    if(this.checkId.has(id)){
      return pathToData === '/' ? this.checkId.get(id) : pathToData.includes('.') ? this.checkId.get(id).files.find(file => { return pathToData === file.urlPath }) : mainData.files.filter(file => {return file.urlPath.includes(pathToData)})
    }
    const mainData = this.findTheTorrent(id)
    if(mainData){
      this.checkId.set(id, mainData)
      return pathToData === '/' ? mainData : pathToData.includes('.') ? mainData.files.find(file => { return pathToData === file.urlPath }) : mainData.files.filter(file => {return file.urlPath.includes(pathToData)})
    }

    // const folderPath = path.join(this._storage, id)
    const authorPath = path.join(this._author, id)
    // const descriptionPath = path.join(this._description, id)
    const useTimeout = opts.timeout ? opts.timeout * 1000 : this._timeout

    if(this.checkHash.test(id)){
      if (await fs.pathExists(authorPath)) {
        const authorStuff = JSON.parse((await fs.readFile(authorPath)).toString())
        const folderPath = path.join(this._storage, authorStuff.title)
        const descriptionPath = path.join(this._description, authorStuff.title)
        const useOpts = await (async () => {if(await fs.pathExists(descriptionPath)){const test = await fs.readFile(descriptionPath);return JSON.parse(test.toString());}else{return {}}})()
        const checkTorrent = await Promise.race([
          this.delayTimeOut(useTimeout, this.errName(new Error(id + ' took too long, it timed out'), 'ErrorTimeout'), false),
          this.startTorrent(folderPath, { ...useOpts, destroyStoreOnDestroy: false })
        ])
        // await fs.writeFile(path.join(this._author, id), JSON.stringify({infohash: checkTorrent.infoHash, title: id}))
        const mainPath = path.join(checkTorrent.path, checkTorrent.name)
        checkTorrent.folder = folderPath
        checkTorrent.address = null
        checkTorrent.own = true
        checkTorrent.infohash = checkTorrent.infoHash
        checkTorrent.title = authorStuff.title
        checkTorrent.files.forEach(file => {file.urlPath = file.path.slice(mainPath.length).replace(/\\/, '/')})

        if(checkTorrent.infohash !== authorStuff.infohash){
          await fs.remove(authorPath)
          await fs.writeFile(path.join(this._author, checkTorrent.infohash), JSON.stringify({infohash: checkTorrent.infoHash, title: checkTorrent.title}))
        }

        this.checkId.set(id, checkTorrent)
        return pathToData === '/' ? checkTorrent : pathToData.includes('.') ? checkTorrent.files.find(file => { return pathToData === file.urlPath }) : checkTorrent.files.filter(file => {return file.urlPath.includes(pathToData)})
      } else {
        const folderPath = path.join(this._storage, id)
        const checkTorrent = await Promise.race([
          this.delayTimeOut(useTimeout, this.errName(new Error(id + ' took too long, it timed out'), 'ErrorTimeout'), false),
          this.midTorrent(id, { path: folderPath, destroyStoreOnDestroy: false })
        ]).catch(err => {
          try {
            const haveIt = this.findTheTorrent(id)
            if(haveIt){
              this.webtorrent.remove(haveIt.infoHash, { destroyStore: false })
            }
          } catch (error) {
            console.error(error)
          }
          throw err
        })
        const mainPath = path.join(checkTorrent.path, checkTorrent.name)
        checkTorrent.folder = folderPath
        checkTorrent.address = null
        checkTorrent.own = false
        checkTorrent.title = null
        checkTorrent.infohash = checkTorrent.infoHash
        checkTorrent.files.forEach(file => {file.urlPath = file.path.slice(mainPath.length).replace(/\\/, '/')})
        this.checkId.set(id, checkTorrent)
        return pathToData === '/' ? checkTorrent : pathToData.includes('.') ? checkTorrent.files.find(file => { return pathToData === file.urlPath }) : checkTorrent.files.filter(file => {return file.urlPath.includes(pathToData)})
      }
    } else if(this.checkAddress.test(id)){
      if(await fs.pathExists(authorPath)){
        const folderPath = path.join(this._storage, id)
        if (!await fs.pathExists(folderPath)) {
          throw new Error('folder does not exist')
        }

        const descriptionPath = path.join(this._description, id)
        const useOpts = await (async () => {if(await fs.pathExists(descriptionPath)){const test = await fs.readFile(descriptionPath);return JSON.parse(test.toString());}else{return {}}})()

        const checkTorrent = await Promise.race([
          this.delayTimeOut(useTimeout, this.errName(new Error(id + ' took too long, it timed out'), 'ErrorTimeout'), false),
          this.startTorrent(folderPath, { ...useOpts, destroyStoreOnDestroy: true })
        ])
        const checkProperty = await Promise.race([
          this.delayTimeOut(this._timeout, this.errName(new Error(id + ' property took too long, it timed out, please try again with only the keypair without the folder'), 'ErrorTimeout'), false),
          this.ownData(id, checkTorrent.infoHash)
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
        const mainPath = path.join(checkTorrent.path, checkTorrent.name)
        checkTorrent.title = null
        checkTorrent.own = true
        checkTorrent.files.forEach(file => {file.urlPath = file.path.slice(mainPath.length).replace(/\\/, '/')})
        this.checkId.set(id, checkTorrent)
        return pathToData === '/' ? checkTorrent : pathToData.includes('.') ? checkTorrent.files.find(file => { return pathToData === file.urlPath }) : checkTorrent.files.filter(file => {return file.urlPath.includes(pathToData)})
      } else {
        const folderPath = path.join(this._storage, id)
        const checkProperty = await Promise.race([
          this.delayTimeOut(this._timeout, this.errName(new Error(id + ' property took too long, it timed out'), 'ErrorTimeout'), false),
          this.resolveFunc(id)
        ])
    
        checkProperty.folder = folderPath
        const dataPath = path.join(checkProperty.folder, checkProperty.infohash)
    
        // if current option is true, then if the infohash for the address is brand new then empty the directory and download the new infohash
        // if the current option is false, then at least make sure the main folder which is named with the public key address exists
        if (this._current) {
          if (!await fs.pathExists(dataPath)) {
            await fs.emptyDir(checkProperty.folder)
          }
        } else {
          if (!await fs.pathExists(checkProperty.folder)) {
            await fs.ensureDir(checkProperty.folder)
          }
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
        const mainPath = path.join(checkTorrent.path, checkTorrent.name)
        checkTorrent.own = false
        checkTorrent.title = null
        checkTorrent.files.forEach(file => {file.urlPath = file.path.slice(mainPath.length).replace(/\\/, '/')})
        this.checkId.set(id, checkTorrent)
        return pathToData === '/' ? checkTorrent : pathToData.includes('.') ? checkTorrent.files.find(file => { return pathToData === file.urlPath }) : checkTorrent.files.filter(file => {return file.urlPath.includes(pathToData)})
      }
    } else {
      throw new Error('invalid identifier was used')
    }
  }
  async publishTorrent(id, pathToData, headers, data, opts = {}){
    if(!opts){
      opts = {}
    }
    const useTimeout = opts.timeout ? opts.timeout * 1000 : this._timeout
    if(id.infohash){
      if(this.checkId.has(id.infohash)){
        this.checkId.delete(id.infohash)
      }
      const activeTorrent = this.findTheTorrent(id.infohash)
      if(activeTorrent){
        await this.stopTorrent(activeTorrent, {destroyStore: false})
      }

      const authorPath = path.join(this._author, id.infohash)
      if (!await fs.pathExists(authorPath)) {
        throw new Error('author does not exist')
      }
      const authorStuff = JSON.parse((await fs.readFile(authorPath)).toString())
      const folderPath = path.join(this._storage, authorStuff.title)

      await fs.ensureDir(folderPath)

      const dataPath = path.join(folderPath, pathToData)
      const descriptionPath = path.join(this._description, authorStuff.title)
      const useOpts = await (async () => {if(opts.opt){await fs.writeFile(descriptionPath, JSON.stringify(opts.opt));return opts.opt;}else if(await fs.pathExists(descriptionPath)){const test = await fs.readFile(descriptionPath);return JSON.parse(test.toString());}else{return {};}})()
      // const useOpts = await (async () => {if(await fs.pathExists(descriptionPath)){const test = await fs.readFile(descriptionPath);return JSON.parse(test.toString());}else if(opts.opt){await fs.writeFile(descriptionPath, JSON.stringify(opts.opt));return opts.opt;}else{return {};}})()
      
      const additionalData = headers ? await this.handleFormData(dataPath, headers, data) : await this.handleRegData(dataPath, data)
      if(additionalData.textData.length){
        await fs.writeFile(path.join(folderPath, authorStuff.title + '-data.txt'), `${additionalData.textData.map(file => {return `${file.key}: ${file.value}\n`})}`, {flag: 'a'})
      }
      const mainData = additionalData.fileData || additionalData.byItSelf

      const checkTorrent = await Promise.race([
        this.delayTimeOut(useTimeout, this.errName(new Error('torrent took too long, it timed out'), 'ErrorTimeout'), false),
        this.startTorrent(folderPath, { ...useOpts, destroyStoreOnDestroy: false })
      ])

      const mainPath = path.join(checkTorrent.path, checkTorrent.name)
      checkTorrent.folder = folderPath
      checkTorrent.title = authorStuff.title
      checkTorrent.address = null
      checkTorrent.own = true
      checkTorrent.infohash = checkTorrent.infoHash
      checkTorrent.files.forEach(file => {file.urlPath = file.path.slice(mainPath.length).replace(/\\/, '/')})

      if(checkTorrent.infohash !== authorStuff.infohash){
        // await fs.remove(authorPath)
        await fs.writeFile(authorPath, JSON.stringify({infohash: checkTorrent.infoHash, title: checkTorrent.title}))
      }

      this.checkId.set(checkTorrent.infohash, checkTorrent)
      return { infohash: checkTorrent.infohash, title: checkTorrent.title, name: checkTorrent.name, length: checkTorrent.length, files: checkTorrent.files, saved: mainData }
    } else if(id.infohash === null){
      const title = uid(20)
      const folderPath = path.join(this._storage, title)
      // if (await fs.pathExists(folderPath)) {
      //   throw new Error('folder already exists')
      // }

      // const activeTorrent = this.findTheTorrent(title)
      // if(activeTorrent){
      //   if(this.checkId.has(activeTorrent.infoHash)){
      //     this.checkId.delete(activeTorrent.infoHash)
      //   }
      //   await this.stopTorrent(activeTorrent, {destroyStore: false})
      // }

      await fs.emptyDir(folderPath)

      const dataPath = path.join(folderPath, pathToData)
      const descriptionPath = path.join(this._description, title)
      const useOpts = await (async () => {if(opts.opt){await fs.writeFile(descriptionPath, JSON.stringify(opts.opt));return opts.opt;}else if(await fs.pathExists(descriptionPath)){const test = await fs.readFile(descriptionPath);return JSON.parse(test.toString());}else{return {};}})()
      // const useOpts = await (async () => {if(await fs.pathExists(descriptionPath)){const test = await fs.readFile(descriptionPath);return JSON.parse(test.toString());}else if(opts.opt){await fs.writeFile(descriptionPath, JSON.stringify(opts.opt));return opts.opt;}else{return {};}})()
      
      const additionalData = headers ? await this.handleFormData(dataPath, headers, data) : await this.handleRegData(dataPath, data)
      if(additionalData.textData.length){
        await fs.writeFile(path.join(folderPath, title + '-data.txt'), `${additionalData.textData.map(file => {return `${file.key}: ${file.value}\n`})}`, {flag: 'a'})
      }
      const mainData = additionalData.fileData || additionalData.byItSelf

      const checkTorrent = await Promise.race([
        this.delayTimeOut(useTimeout, this.errName(new Error('torrent took too long, it timed out'), 'ErrorTimeout'), false),
        this.startTorrent(folderPath, { ...useOpts, destroyStoreOnDestroy: false })
      ])

      const mainPath = path.join(checkTorrent.path, checkTorrent.name)
      checkTorrent.folder = folderPath
      checkTorrent.title = title
      checkTorrent.address = null
      checkTorrent.own = true
      checkTorrent.infohash = checkTorrent.infoHash
      checkTorrent.files.forEach(file => {file.urlPath = file.path.slice(mainPath.length).replace(/\\/, '/')})
      const authorPath = path.join(this._author, checkTorrent.infohash)
      await fs.writeFile(authorPath, JSON.stringify({infohash: checkTorrent.infoHash, title: checkTorrent.title}))

      this.checkId.set(checkTorrent.infohash, checkTorrent)
      return { infohash: checkTorrent.infohash, title: checkTorrent.title, name: checkTorrent.name, length: checkTorrent.length, files: checkTorrent.files, saved: mainData }
    } else if((id.address || id.address === null) && (id.secret || id.secret === null)){
      if (!id.address || !id.secret) {
        id = this.createKeypair()
      } else {
        if(this.checkId.has(id.address)){
          this.checkId.delete(id.address)
        }
        const activeTorrent = this.findTheTorrent(id.address)
        if(activeTorrent){
          await this.stopTorrent(activeTorrent, {destroyStore: false})
        }
      }
      const folderPath = path.join(this._storage, id.address)
      await fs.ensureDir(folderPath)

      const dataPath = path.join(folderPath, pathToData)
      const descriptionPath = path.join(this._description, id.address)
      // const useOpts = await (async () => {if(opts.opt){await fs.writeFile(descriptionPath, JSON.stringify(opts.opt));return opts.opt;}else if(await fs.pathExists(descriptionPath)){const test = await fs.readFile(descriptionPath);return JSON.parse(test.toString());}else{return {};}})()
      const useOpts = await (async () => {if(await fs.pathExists(descriptionPath)){const test = await fs.readFile(descriptionPath);return JSON.parse(test.toString());}else if(opts.opt){await fs.writeFile(descriptionPath, JSON.stringify(opts.opt));return opts.opt;}else{return {};}})()

      const additionalData = headers ? await this.handleFormData(dataPath, headers, data) : data ? await this.handleRegData(dataPath, data) : []
      if(additionalData.textData.length){
        await fs.writeFile(path.join(folderPath, id.address + '-data.txt'), `${additionalData.textData.map(file => {return `${file.key}: ${file.value}\n`})}`, {flag: 'a'})
      }
      const mainData = additionalData.fileData || additionalData.byItSelf

      const checkTorrent = await Promise.race([
        this.delayTimeOut(useTimeout, this.errName(new Error('torrent took too long, it timed out'), 'ErrorTimeout'), false),
        this.startTorrent(folderPath, { ...useOpts, destroyStoreOnDestroy: false })
      ])
      const checkProperty = await Promise.race([
        this.delayTimeOut(this._timeout, this.errName(new Error(id.address + ' property took too long, it timed out, please try again with only the keypair without the folder'), 'ErrorTimeout'), false),
        this.publishFunc(id.address, id.secret, { ih: checkTorrent.infoHash }, opts.count ? opts.count : null)
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
      const mainPath = path.join(checkTorrent.path, checkTorrent.name)
      checkTorrent.title = null
      checkTorrent.own = true
      checkTorrent.files.forEach(file => {file.urlPath = file.path.slice(mainPath.length).replace(/\\/, '/')})
      this.checkId.set(id.address, checkTorrent)
      return { address: id.address, secret: id.secret, infohash: checkTorrent.infohash, sequence: checkTorrent.sequence, name: checkTorrent.name, length: checkTorrent.length, files: checkTorrent.files, saved: mainData}
    } else {
      throw new Error('title or address/secret is needed or needs to be null')
    }
  }
  async shredTorrent(id, pathToData, opts = {}){
    if(!opts){
      opts = {}
    }

    let kindOfId
    if(this.checkAddress.test(id)){
      kindOfId = 'address'

      const activeTorrent = this.findTheTorrent(id)
      const useTimeout = opts.timeout ? opts.timeout * 1000 : this._timeout
      if(activeTorrent){
        await Promise.race([
          this.stopTorrent(activeTorrent, {destroyStore: false}),
          this.delayTimeOut(useTimeout, this.errName(new Error('did not remove in time'), 'ErrorTimeout'), false)
        ])
      }
  
      if(this.checkId.has(id)){
        this.checkId.delete(id)
      }

      const authorPath = path.join(this._author, id)
      const folderPath = path.join(this._storage, id)
      const descriptionPath = path.join(this._description, id)
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
      } else {
        if(!await fs.pathExists(authorPath)){
          throw new Error('Must be creator to delete any files or directories inside the torrent')
        }

        if(await fs.pathExists(dataPath)){
          await fs.remove(dataPath)
        }
      }

    } else if(this.checkHash.test(id)){
      kindOfId = 'infohash'

      const activeTorrent = this.findTheTorrent(id)
      const useTimeout = opts.timeout ? opts.timeout * 1000 : this._timeout
      if(activeTorrent){
        await Promise.race([
          this.stopTorrent(activeTorrent, {destroyStore: false}),
          this.delayTimeOut(useTimeout, this.errName(new Error('did not remove in time'), 'ErrorTimeout'), false)
        ])
      }
  
      if(this.checkId.has(id)){
        this.checkId.delete(id)
      }

      const authorPath = path.join(this._author, id)
      // const isAuthorPath = await fs.pathExists(authorPath) ? null : null
      const authorStuff = await fs.pathExists(authorPath) ? JSON.parse((await fs.readFile(authorPath)).toString()) : null
      const folderPath = authorStuff ? path.join(this._storage, authorStuff.title) : path.join(this._storage, id)
      const descriptionPath = authorStuff ? path.join(this._description, authorStuff.title) : path.join(this._description, id)
      const dataPath = path.join(folderPath, pathToData)

      if(!await fs.pathExists(folderPath)){
        throw new Error('did not find any torrent data to delete')
      }

      if(pathToData === '/'){
        if(authorStuff){
          await fs.remove(authorPath)
        }
        await fs.remove(folderPath)
  
        if(await fs.pathExists(descriptionPath)){
          await fs.remove(descriptionPath)
        }
      } else {
        if(!authorStuff){
          throw new Error('Must be creator to delete any files or directories inside the torrent')
        }

        if(await fs.pathExists(dataPath)){
          await fs.remove(dataPath)
        }

        const useOpts = descriptionPath ? await (async () => {if(await fs.pathExists(descriptionPath)){const test = await fs.readFile(descriptionPath);return JSON.parse(test.toString());}else{return {};}})() : {}

        const dataFromTorrent = await new Promise((resolve, reject) => {
          createTorrent(folderPath, useOpts, (err, torrent) => {
            if(err){
              reject(err)
            } else if(torrent){
              resolve(torrent)
            } else {
              reject(new Error('could not get torrent data from the folder'))
            }
          })
        })

        const dataFromFolder = await (async () => {
          try {
            return parseTorrent(dataFromTorrent)
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

        if(dataFromFolder.infoHash !== authorStuff.infohash){
          await fs.remove(authorPath)
        }

        // if(dataFromFolder.infoHash !== id){
        //   await fs.remove(authorPath)
        // }

        await fs.writeFile(path.join(this._author, dataFromFolder.infoHash), JSON.stringify({infohash: dataFromFolder.infoHash, title: authorStuff.title}))

        id = dataFromFolder.infoHash
      }
    } else {
      throw new Error('id is not valid')
    }

    return {id, path: pathToData, type: kindOfId}
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
  stopTorrent(torrent, opts){
    return new Promise((resolve, reject) => {
      this.webtorrent.remove(torrent.infoHash, opts, (error) => {
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

  handleFormData (folderPath, headers, data) {
    const bb = busboy({ headers })

    return new Promise((resolve, reject) => {
      const textData = []
      const fileData = []
      function handleRemoval () {
        bb.off('field', handleFields)
        bb.off('file', handleFiles)
        bb.off('error', handleErrors)
        bb.off('finish', handleFinish)
      }
      function handleFields (key, value) {
        textData.push({key, value})
      }
      function handleFiles (name, file, info) {
        fileData.push(info.filename)
        Readable.from(file).pipe(fs.createWriteStream(path.join(folderPath, info.filename)))
        // Readable.from(file).pipe(fs.createWriteStream(path.join(folderPath, info.filename))).once('close', () => {fileData.push(info.filename)})
      }
      function handleErrors (error) {
        handleRemoval()
        reject(error)
      }
      function handleFinish () {
        handleRemoval()
        resolve({textData, fileData})
      }
      bb.on('field', handleFields)
      bb.on('file', handleFiles)
      bb.on('error', handleErrors)
      bb.on('finish', handleFinish)
      Readable.from(data).pipe(bb)
    })
  }

  handleRegData(folderPath, body){
    return new Promise((resolve, reject) => {
      const byItSelf = [folderPath.split('\\').filter(Boolean).pop()]
      const destination = fs.createWriteStream(folderPath)
      const source = Readable.from(body)
      source.pipe(destination)
      function handleOff(){
        source.off('error', onSourceError)
        destination.off('error', onDestinationError)
        source.off('close', onSourceClose)
      }
      function onSourceError(err){
        handleOff()
        reject(err)
      }
      function onDestinationError(err){
        handleOff()
        reject(err)
      }
      function onSourceClose(){
        handleOff()
        resolve({byItSelf})
      }
      source.on('error', onSourceError)
      destination.on('error', onDestinationError)
      source.on('close', onSourceClose)
    })
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
  createKeypair () {
    const { publicKey, secretKey } = ed.createKeyPair(ed.createSeed())
    return { address: publicKey.toString('hex'), secret: secretKey.toString('hex') }
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
  async listDirectory(){
    return await fs.readdir(this._storage, {withFileTypes: true})
  }
}

module.exports = Torrentz

/* 
comments
*/