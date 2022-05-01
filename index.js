const WebTorrent = require('webtorrent')
const fs = require('fs-extra')
const path = require('path')
const sha1 = require('simple-sha1')
const ed = require('ed25519-supercop')
const bencode = require('bencode')
const busboy = require('busboy')
const { Readable } = require('stream')

const BTPK_PREFIX = 'urn:btpk:'

// saves us from saving secret keys(saving secret keys even encrypted secret keys is something i want to avoid)
// with this function which was taken from the bittorrent-dht package
// we save only the signatures when we first publish a BEP46 torrent
function encodeSigData (msg) {
  const ref = { seq: msg.seq, v: msg.v }
  if (msg.salt) ref.salt = msg.salt
  return bencode.encode(ref).slice(1, -1)
}

// setting up constants
const checkHash = /^[a-fA-F0-9]{40}$/
const checkAddress = /^[a-fA-F0-9]{64}$/
const checkTitle = /^[a-zA-Z0-9]/
const defOpts = { folder: __dirname, storage: 'storage', author: 'author', current: true, timeout: 60000 }

class Torrentz {
  constructor (opts = {}) {
    const finalOpts = { ...defOpts, ...opts }
    this._timeout = finalOpts.timeout

    finalOpts.folder = path.resolve(finalOpts.folder)
    fs.ensureDirSync(finalOpts.folder)

    this._current = finalOpts.current
    this._folder = finalOpts.folder
    this._storage = path.join(this._folder, finalOpts.storage)
    this._author = path.join(this._folder, finalOpts.author)
    if (!fs.pathExistsSync(this._storage)) {
      fs.ensureDirSync(this._storage)
    }
    if (!fs.pathExistsSync(this._author)) {
      fs.ensureDirSync(this._author)
    }

    this.webtorrent = ((finalOpts) => {
      if(finalOpts.webtorrent){
        finalOpts.webtorrent.dht._verify = ed.verify
        return finalOpts.webtorrent
      } else {
        return new WebTorrent({ dht: { verify: ed.verify } })
      }
    })(finalOpts)
    
    this.webtorrent.on('error', error => {
      console.error(error)
    })
    this._readyToGo = true

    // run the start up function
    // this.startUp().catch(error => { console.error(error) })

    // run the keepUpdated function every 1 hour, it keep the data active by putting the data back into the dht, don't run it if it is still working from the last time it ran the keepUpdated function
    this.updateRoutine = setInterval(() => {
      if (this._readyToGo) {
        this.keepUpdated().then(data => console.log('routine update had an resolve', data)).catch(error => console.error('routine update had a reject', error))
      }
    }, 1800000)
  }

  // keep data active in the dht, runs every hour
  async keepUpdated () {
    this._readyToGo = false
    const dir = await fs.readdir(this._author)
    for(const data of dir){
      const useData = await fs.readFile(path.join(this._author, data))
      const parsedData = JSON.parse(useData.toString())
      try {
        await this.saveData(parsedData)
      } catch (err) {
        console.error(err)
      }
      await new Promise((resolve, reject) => setTimeout(resolve, 4000))
    }
    for (const torrent of this.webtorrent.torrents) {
      if (torrent.address && !torrent.own) {
        try {
          await this.saveData(torrent)
        } catch (err) {
          console.error(err)
        }
        await new Promise((resolve, reject) => setTimeout(resolve, 4000))
      }
    }
    this._readyToGo = true
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
    if (!await fs.pathExists(this._author + path.sep + address)) {
      throw new Error('data was not found')
    }
    // get data from file
    let data = await fs.readFile(this._author + path.sep + address)
    // parse the data file
    data = JSON.parse(data.toString())

    const signatureBuff = Buffer.from(data.sig, 'hex')
    const encodedSignatureData = encodeSigData({ seq: data.sequence, v: { ih: infoHash, ...data.stuff } })
    const addressBuff = Buffer.from(data.address, 'hex')

    if (infoHash !== data.infohash || !ed.verify(signatureBuff, encodedSignatureData, addressBuff)) {
      throw new Error('data does not match signature')
    }
    return data
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
    if (!checkHash.test(getData.v.ih.toString('utf-8')) || !Number.isInteger(getData.seq)) {
      throw new Error('data is invalid')
    }
    for (const prop in getData.v) {
      getData.v[prop] = getData.v[prop].toString('utf-8')
    }
    const { ih, ...stuff } = getData.v
    return { magnet: `magnet:?xs=${BTPK_PREFIX}${address}`, address, infohash: ih, sequence: getData.seq, stuff, sig: getData.sig.toString('hex'), from: getData.id.toString('hex') }
  }

  // publish an infohash under a public key address in the dht
  async publishFunc (address, secret, text, count) {
    for (const prop in text) {
      if (typeof (text[prop]) !== 'string') {
        throw new Error('text data must be strings')
      }
    }
    if (!checkHash.test(text.ih)) {
      throw new Error('must have infohash')
    }
    if (!address || !secret) {
      throw new Error('must have address and secret')
    }

    const buffAddKey = Buffer.from(address, 'hex')
    const buffSecKey = secret ? Buffer.from(secret, 'hex') : null
    const v = text

    let main = null
    let seq = null
    const authorPath = path.join(this._author, address)
    if (await fs.pathExists(authorPath)) {
      main = await fs.readFile(authorPath)
      main = JSON.parse(main.toString())
      seq = main.sequence + 1
    } else {
      seq = count === null ? 0 : count
    }

    const buffSig = ed.sign(encodeSigData({ seq, v }), buffAddKey, buffSecKey)

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
    main = { magnet: `magnet:?xs=${BTPK_PREFIX}${address}`, address, infohash: ih, sequence: seq, stuff, sig: buffSig.toString('hex'), ...putData }
    await fs.writeFile(authorPath, JSON.stringify(main))
    return main
  }

  async loadTorrent(id, checkTimeout = 0){
    const mainData = this.findTheTorrent(id)
    if(mainData){
      return mainData
    }

    const folderPath = path.join(this._storage, id)
    const authorPath = path.join(this._author, id)
    const useTimeout = checkTimeout ? checkTimeout : this._timeout

    if(checkHash.test(id)){
      const checkTorrent = await Promise.race([
        this.delayTimeOut(useTimeout, this.errName(new Error(id + ' took too long, it timed out'), 'ErrorTimeout'), false),
        new Promise((resolve, reject) => {
          this.webtorrent.add(id, { path: folderPath, destroyStoreOnDestroy: true }, torrent => {
            resolve(torrent)
          })
        })
      ])
      const mainPath = path.join(checkTorrent.path, checkTorrent.name)
      checkTorrent.folder = folderPath
      checkTorrent.address = null
      checkTorrent.own = false
      checkTorrent.title = null
      checkTorrent.infohash = checkTorrent.infoHash
      checkTorrent.files.forEach(file => {file.urlPath = file.path.slice(mainPath.length).replace(/\\/, '/')})
      return checkTorrent
    } else if(checkAddress.test(id)){
      if(await fs.pathExists(authorPath)){
        if (!await fs.pathExists(folderPath)) {
          throw new Error('folder does not exist')
        }

        const checkTorrent = await Promise.race([
          this.delayTimeOut(useTimeout, this.errName(new Error(id + ' took too long, it timed out'), 'ErrorTimeout'), false),
          new Promise((resolve, reject) => {
            this.webtorrent.seed(folderPath, { destroyStoreOnDestroy: true }, torrent => {
              resolve(torrent)
            })
          })
        ])
        const checkProperty = await Promise.race([
          this.delayTimeOut(this._timeout, this.errName(new Error(id + ' property took too long, it timed out, please try again with only the keypair without the folder'), 'ErrorTimeout'), false),
          this.ownData(id, checkTorrent.infoHash)
        ]).catch(error => {
          this.webtorrent.remove(checkTorrent.infoHash, { destroyStore: false })
          throw error
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
        return checkTorrent
      } else {
        const checkProperty = await Promise.race([
          this.delayTimeOut(this._timeout, this.errName(new Error(id + ' property took too long, it timed out'), 'ErrorTimeout'), false),
          this.resolveFunc(id)
        ])
    
        checkProperty.folder = folderPath
        const dataPath = path.join(checkProperty.folder, checkProperty.infoHash)
    
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
          new Promise((resolve, reject) => {
            this.webtorrent.add(checkProperty.infohash, { path: dataPath, destroyStoreOnDestroy: true }, torrent => {
              resolve(torrent)
            })
          })
        ])
        // don't overwrite the torrent's infohash even though they will both be the same
        for (const prop in checkProperty) {
          checkTorrent[prop] = checkProperty[prop]
        }
        const mainPath = path.join(checkTorrent.path, checkTorrent.name)
        checkTorrent.own = false
        checkTorrent.title = null
        checkTorrent.files.forEach(file => {file.urlPath = file.path.slice(mainPath.length).replace(/\\/, '/')})
        return checkTorrent
      }
    } else if(checkTitle.test(id)){
      if (!await fs.pathExists(folderPath)) {
        throw new Error('folder does not exist')
      }
      const checkTorrent = await Promise.race([
        this.delayTimeOut(useTimeout, this.errName(new Error(id + ' took too long, it timed out'), 'ErrorTimeout'), false),
        new Promise((resolve, reject) => {
          this.webtorrent.seed(folderPath, { destroyStoreOnDestroy: true }, torrent => {
            resolve(torrent)
          })
        })
      ])
      const mainPath = path.join(checkTorrent.path, checkTorrent.name)
      checkTorrent.folder = folderPath
      checkTorrent.address = null
      checkTorrent.own = true
      checkTorrent.infohash = checkTorrent.infoHash
      checkTorrent.title = id
      checkTorrent.files.forEach(file => {file.urlPath = file.path.slice(mainPath.length).replace(/\\/, '/')})
      await fs.writeFile(path.join(authorPath, checkTorrent.title), checkTorrent.infohash)
      return checkTorrent
    } else {
      throw new Error('invalid identifier was used')
    }
  }
  async publishTorrent(update, id, count, headers, data, checkTimeout = 0){
    const useTimeout = checkTimeout ? checkTimeout : this._timeout
    if(update){
      if (!id || !id.address || !id.secret) {
        id = this.createKeypair()
      } else {
        const activeTorrent = this.findTheTorrent(id.address)
        if(activeTorrent){
          await new Promise((resolve, reject) => {
            this.webtorrent.remove(activeTorrent.infoHash, {destroyStore: false}, error => {
              if(error){
                reject(error)
              } else {
                resolve()
              }
            })
          })
        }
      }
      const folderPath = path.join(this._storage, id.address)
      await fs.emptyDir(folderPath)
      // await Promise.race([
      //   this.delayTimeOut(this._timeout, this.errName(new Error('took too long to write to disk'), 'ErrorTimeout'), false),
      //   this.handleFormData(folderPath, headers, data)
      // ])
      const additionalData = await this.handleFormData(folderPath, headers, data)
      if(additionalData.length){
        await fs.writeFile(path.join(folderPath, Date.now() + '-data.txt'), `Outercon\n\n${additionalData.map(file => {return file.key + ': ' + file.value + '\n'})}`)
      }
      const checkFolderPath = await fs.readdir(folderPath, { withFileTypes: false })
      if (!checkFolderPath.length) {
        await fs.remove(folderPath)
        throw new Error('data could not be written to new torrent')
      }
      const checkTorrent = await Promise.race([
        this.delayTimeOut(useTimeout, this.errName(new Error('torrent took too long, it timed out'), 'ErrorTimeout'), false),
        new Promise((resolve, reject) => {
          this.webtorrent.seed(folderPath, { destroyStoreOnDestroy: true }, torrent => {
            resolve(torrent)
          })
        })
      ])
      const checkProperty = await Promise.race([
        this.delayTimeOut(this._timeout, this.errName(new Error(id.address + ' property took too long, it timed out, please try again with only the keypair without the folder'), 'ErrorTimeout'), false),
        this.publishFunc(id.address, id.secret, { ih: checkTorrent.infoHash }, count)
      ]).catch(error => {
        this.webtorrent.remove(checkTorrent.infoHash, { destroyStore: false })
        throw error
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
      return { torrent: checkTorrent, address: id.address, secret: id.secret }
    } else {
      if(id.sub){
        const subTorrent = this.findTheTorrent(id.sub)
        if(subTorrent){
          await new Promise((resolve, reject) => {
            this.webtorrent.remove(subTorrent.infoHash, {destroyStore: false}, error => {
              if(error){
                reject(error)
              } else {
                resolve()
              }
            })
          })
        }
        await fs.remove(path.join(this._storage, id.sub))
      }
      const activeTorrent = this.findTheTorrent(id.title)
      if(activeTorrent){
        await new Promise((resolve, reject) => {
          this.webtorrent.remove(activeTorrent.infoHash, {destroyStore: false}, error => {
            if(error){
              reject(error)
            } else {
              resolve()
            }
          })
        })
      }
      const folderPath = path.join(this._storage, id.title)
      const authorPath = path.join(this._author, id.title)
      await fs.emptyDir(folderPath)
      // await Promise.race([
      //   this.delayTimeOut(this._timeout, this.errName(new Error('took too long to write to disk'), 'ErrorTimeout'), false),
      //   this.handleFormData(folderPath, headers, data)
      // ])
      const additionalData = await this.handleFormData(folderPath, headers, data)
      if(additionalData.length){
        await fs.writeFile(path.join(folderPath, Date.now() + '-data.txt'), `Outercon\n\n${additionalData.map(file => {return file.key + ': ' + file.value + '\n'})}`)
      }
      const checkFolderPath = await fs.readdir(folderPath, { withFileTypes: false })
      if (!checkFolderPath.length) {
        await fs.remove(folderPath)
        throw new Error('data could not be written to new torrent')
      }
      const checkTorrent = await Promise.race([
        this.delayTimeOut(useTimeout, this.errName(new Error('torrent took too long, it timed out'), 'ErrorTimeout'), false),
        new Promise((resolve, reject) => {
          this.webtorrent.seed(folderPath, { destroyStoreOnDestroy: true }, torrent => {
            resolve(torrent)
          })
        })
      ])
      const mainPath = path.join(checkTorrent.path, checkTorrent.name)
      checkTorrent.folder = folderPath
      checkTorrent.title = id.title
      checkTorrent.address = null
      checkTorrent.own = true
      checkTorrent.infohash = checkTorrent.infoHash
      checkTorrent.files.forEach(file => {file.urlPath = file.path.slice(mainPath.length).replace(/\\/, '/')})
      await fs.writeFile(path.join(authorPath, checkTorrent.title), checkTorrent.infohash)
      return { torrent: checkTorrent, infohash: checkTorrent.infohash, title: checkTorrent.title }
    }
  }
  async shredTorrent(id){
    const folderPath = path.join(this._storage, id)
    if(!await fs.pathExists(folderPath)){
      throw new Error('did not find any torrent data to delete')
    }
    const activeTorrent = this.findTheTorrent(id)
    if(activeTorrent){
      await new Promise((resolve, reject) => {
        this.webtorrent.remove(activeTorrent.infoHash, {destroyStore: false}, error => {
          if(error){
            reject(error)
          } else {
            resolve()
          }
        })
      })
    }
    await fs.remove(folderPath)

    const authorPath = path.join(this._author, id)
    if(await fs.pathExists(authorPath)){
      await fs.remove(authorPath)
    }
    return id
  }
  findTheTorrent(id){
    let data = null
    for(const torrent of this.webtorrent.torrents){
      if(torrent.address === id || torrent.infohash === id || torrent.title === id){
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
        Readable.from(file).pipe(fs.createWriteStream(path.join(folderPath, info.filename)))
      }
      function handleErrors (error) {
        handleRemoval()
        reject(error)
      }
      function handleFinish () {
        handleRemoval()
        resolve(textData)
      }
      bb.on('field', handleFields)
      bb.on('file', handleFiles)
      bb.on('error', handleErrors)
      bb.on('finish', handleFinish)
      Readable.from(data).pipe(bb)
    })
  }

  // -------------- the below functions are BEP46 helpders, especially bothGetPut which keeps the data active in the dht ----------------

  // this function is used to keep data active in the dht
  // torrent data is passed in as an argument
  // it gets the most recent data from another user in the dht
  // then puts that most recent data back into the dht
  // if it  can not get the most recent data from another user
  // then we put the torrent data that we currently have back into the dht
  bothGetPut (data) {
    return new Promise((resolve, reject) => {
      const buffAddKey = Buffer.from(data.address, 'hex')
      const buffSigData = Buffer.from(data.sig, 'hex')
      sha1(buffAddKey, (targetID) => {
        this.webtorrent.dht.get(targetID, (getErr, getData) => {
          if (getErr) {
            console.error(getErr)
          }
          if (getData) {
            this.webtorrent.dht.put(getData, (putErr, hash, number) => {
              if (putErr) {
                reject(putErr)
              } else {
                resolve({ getData, putData: { hash: hash.toString('hex'), number } })
              }
            })
          } else if (!getData) {
            this.webtorrent.dht.put({ k: buffAddKey, v: { ih: data.infoHash, ...data.stuff }, seq: data.sequence, sig: buffSigData }, (putErr, hash, number) => {
              if (putErr) {
                reject(putErr)
              } else {
                resolve({ hash: hash.toString('hex'), number })
              }
            })
          }
        })
      })
    })
  }

  // keep the data we currently hold active by putting it back into the dht
  saveData (data) {
    return new Promise((resolve, reject) => {
      this.webtorrent.dht.put({ k: Buffer.from(data.address, 'hex'), v: { ih: data.infoHash, ...data.stuff }, seq: data.sequence, sig: Buffer.from(data.sig, 'hex') }, (error, hash, number) => {
        if (error) {
          reject(error)
        } else {
          resolve({ hash: hash.toString('hex'), number })
        }
      })
    })
  }

  // tries to get the data from another user and put that recent data back into the dht to keep the data active
  keepCurrent (address) {
    return new Promise((resolve, reject) => {
      const buffAddKey = Buffer.from(address, 'hex')

      sha1(buffAddKey, (targetID) => {
        this.webtorrent.dht.get(targetID, (getErr, getData) => {
          if (getErr) {
            reject(getErr)
          } else if (getData) {
            this.webtorrent.dht.put(getData, (putErr, hash, number) => {
              if (putErr) {
                reject(putErr)
              } else {
                resolve({ getData, putData: { hash: hash.toString('hex'), number } })
              }
            })
          } else if (!getData) {
            reject(new Error('could not find property'))
          }
        })
      })
    })
  }

  // create a keypair
  createKeypair () {
    const { publicKey, secretKey } = ed.createKeyPair(ed.createSeed())

    return { address: publicKey.toString('hex'), secret: secretKey.toString('hex') }
  }

  // extract the public key/address out of a link
  addressFromLink (link) {
    if (!link || typeof (link) !== 'string') {
      return ''
    } else if (link.startsWith('bt')) {
      try {
        const parsed = new URL(link)

        if (!parsed.hostname) {
          return ''
        } else {
          return parsed.hostname
        }
      } catch (error) {
        console.error(error)
        return ''
      }
    } else if (link.startsWith('magnet')) {
      try {
        const parsed = new URL(link)

        const xs = parsed.searchParams.get('xs')

        const isMutableLink = xs && xs.startsWith(BTPK_PREFIX)

        if (!isMutableLink) {
          return ''
        } else {
          return xs.slice(BTPK_PREFIX.length)
        }
      } catch (error) {
        console.error(error)
        return ''
      }
    } else {
      return ''
    }
  }
}

module.exports = Torrentz