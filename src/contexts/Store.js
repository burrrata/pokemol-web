import React, { useState, useEffect, createContext } from 'react';
import Web3Modal from 'web3modal';

import { useInterval } from '../utils/PollingUtil';
import { WalletStatuses, currentStatus } from '../utils/WalletStatus';
import { createWeb3User, w3connect, providerOptions } from '../utils/Auth';
import { DaoService, USER_TYPE } from '../utils/DaoService';
import { getChainData } from '../utils/chains';
import config from '../config';
import { get } from '../utils/Requests';

export const CurrentUserContext = createContext();
export const CurrentWalletContext = createContext();
export const LoaderContext = createContext(false);
export const ModalContext = createContext();
export const RefreshContext = createContext();
export const DaoDataContext = createContext();
export const DaoServiceContext = createContext();
export const Web3ConnectContext = createContext();

// main store of global state
const Store = ({ children, daoParam }) => {
  // store of aws auth information and sdk
  const [currentUser, setCurrentUser] = useState();
  // stores user wallet balances and shares
  const [currentWallet, setCurrentWallet] = useState({
    eth: 0,
    tokenBalance: 0,
    allowance: 0,
    shares: 0,
    state: null,
    devices: null,
    _txList: [],
    addrByBelegateKey: null,
    status: WalletStatuses.Unknown,
  });

  // modal state for open once
  const [hasOpened, setHasOpened] = useState({});

  // const [name, setName] = useState('MetaCartel DAO');
  const [loading, setLoading] = useState(false);
  // set initial delay to 1 second to update sdk balance
  const [delay, setDelay] = useState(1000);

  const [daoService, setDaoService] = useState();
  const [daoData, setDaoData] = useState();

  const [web3Connect, setWeb3Connect] = useState(
    new Web3Modal({
      network: getChainData(config.CHAIN_ID).network, // optional
      providerOptions, // required
      cacheProvider: true,
    }),
  );

  useEffect(() => {
    // runs on app load, sets up user auth and sdk if necessary
    const initCurrentUser = async () => {
      let loginType = localStorage.getItem('loginType') || USER_TYPE.READ_ONLY;
      // do nothing if user is set correctly
      if (currentUser && currentUser.type === loginType) {
        return;
      }

      let apiData = null;
      let version = null;

      try {
        const daoRes = await get(`moloch/${daoParam}`);
        apiData = daoRes.data;
        version = apiData.version || '1';
      } catch (err) {
        console.log('api fetch error');
      }

      // if (!daoParam || !apiData) {
      if (!daoParam || !apiData) {
        return;
      }

      if (web3Connect.cachedProvider) {
        loginType = USER_TYPE.WEB3;
      }

      let user;
      let dao;
      try {
        console.log(`Initializing user type: ${loginType || 'read-only'}`);

        switch (loginType) {
          case USER_TYPE.WEB3: {
            if (web3Connect.cachedProvider) {
              const { web3Connect: w3c, web3, provider } = await w3connect(
                web3Connect,
              );
              const [account] = await web3.eth.getAccounts();

              setWeb3Connect(w3c);
              user = createWeb3User(account);
              dao = await DaoService.instantiateWithWeb3(
                user.attributes['custom:account_address'],
                provider,
                daoParam,
                version,
              );
              dao.daoAddress = daoParam;
            } else {
              dao = await DaoService.instantiateWithReadOnly(daoParam, version);
            }
            break;
          }
          case USER_TYPE.READ_ONLY:
          default:
            dao = await DaoService.instantiateWithReadOnly(daoParam, version);
            break;
        }
        setCurrentUser(user);
        localStorage.setItem('loginType', loginType);
      } catch (e) {
        console.error(
          `Could not log in with loginType ${loginType}: ${e.toString()}`,
        );

        localStorage.setItem('loginType', '');

        dao = await DaoService.instantiateWithReadOnly(daoParam, version);
      } finally {
        setDaoService(dao);
      }
    };

    initCurrentUser();
  }, [currentUser, setDaoService, daoParam, web3Connect]);

  // global polling service
  useInterval(async () => {
    if (!daoService) {
      console.log(`DaoService not initialized yet`);
      return;
    }

    if (!currentUser || currentUser.type === USER_TYPE.READ_ONLY) {
      // early return
      return;
    }

    const accountDevices = null;
    // get account address from aws
    const acctAddr = currentUser.attributes['custom:account_address'];
    // get delegate key from contract to see if it is different
    const addrByDelegateKey = await daoService.mcDao.memberAddressByDelegateKey(
      acctAddr,
    );

    // get weth balance and allowance of contract
    // const wethWei = await tokenService.balanceOf(acctAddr);
    const tokenBalanceWei = await daoService.token.balanceOf(acctAddr);
    const allowanceWei = await daoService.token.allowance(
      acctAddr,
      daoService.daoAddress,
    );
    // convert from wei to eth
    const tokenBalance = daoService.web3.utils.fromWei(tokenBalanceWei);
    const allowance = daoService.web3.utils.fromWei(allowanceWei);

    // get member shares of dao contract
    const member = await daoService.mcDao.members(addrByDelegateKey);
    // shares will be 0 if not a member, could also be 0 if rage quit
    // TODO: check membersheip a different way
    const shares = parseInt(member.shares);
    const loot = parseInt(member.loot);
    const jailed = parseInt(member.jailed);
    const highestIndexYesVote = member.highestIndexYesVote;

    let eth = 0;
    let state = WalletStatuses.Unknown;

    eth = await daoService.getAccountEth();
    state = daoService.getAccountState();
    setLoading(false);

    setDelay(60000);

    // check transactions left over in bcprocessor storage
    const _txList = daoService.bcProcessor.getTxList(acctAddr);
    const pendingList = daoService.bcProcessor.getTxPendingList(acctAddr);

    if (pendingList.length) {
      for (let i = 0; i < pendingList.length; i++) {
        await daoService.bcProcessor.checkTransaction(pendingList[i].tx);
      }
    }

    const status = currentStatus(currentWallet, currentUser, state);

    // set state
    setCurrentWallet({
      ...currentWallet,
      ...{
        // tokenBalance: +tokenBalance,
        // allowance: +allowance,
        tokenBalance,
        allowance,
        eth,
        state,
        loot,
        highestIndexYesVote,
        jailed,
        shares,
        accountDevices,
        _txList,
        addrByDelegateKey,
        status,
      },
    });
  }, delay);

  return (
    <LoaderContext.Provider value={[loading, setLoading]}>
      {/* <DaoContext.Provider value={[daoService, setDaoService]}> */}
      <DaoDataContext.Provider value={[daoData, setDaoData]}>
        <ModalContext.Provider value={[hasOpened, setHasOpened]}>
          <RefreshContext.Provider value={[delay, setDelay]}>
            <Web3ConnectContext.Provider value={[web3Connect, setWeb3Connect]}>
              <DaoServiceContext.Provider value={[daoService, setDaoService]}>
                <CurrentUserContext.Provider
                  value={[currentUser, setCurrentUser]}
                >
                  <CurrentWalletContext.Provider
                    value={[currentWallet, setCurrentWallet]}
                  >
                    {children}
                  </CurrentWalletContext.Provider>
                </CurrentUserContext.Provider>
              </DaoServiceContext.Provider>
            </Web3ConnectContext.Provider>
          </RefreshContext.Provider>
        </ModalContext.Provider>
      </DaoDataContext.Provider>
      {/* </DaoContext.Provider> */}
    </LoaderContext.Provider>
  );
};

export default Store;
