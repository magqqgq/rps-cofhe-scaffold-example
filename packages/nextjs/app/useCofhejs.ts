import { useCallback, useMemo } from "react";
import { useEffect } from "react";
import { PermitOptions, cofhejs, permitStore } from "cofhejs/web";
import { PublicClient, WalletClient, createWalletClient, http } from "viem";
import { PrivateKeyAccount, privateKeyToAccount } from "viem/accounts";
import * as chains from "viem/chains";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";
import { create, useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import scaffoldConfig from "~~/scaffold.config";
import { notification } from "~~/utils/scaffold-eth";

const ChainEnvironments = {
  // Ethereum
  [chains.mainnet.id]: "MAINNET",
  // Arbitrum
  [chains.arbitrum.id]: "MAINNET",
  // Ethereum Sepolia
  [chains.sepolia.id]: "TESTNET",
  // Arbitrum Sepolia
  [chains.arbitrumSepolia.id]: "TESTNET",
  // Hardhat
  [chains.hardhat.id]: "MOCK",
} as const;

// ZKV SIGNER
/**
 * Resolves the mock ZK-verifier signer key from the build-time environment.
 *
 * This key is used **only** in the local MOCK environment (`mockConfig` below, see
 * the `ChainEnvironments` map) and it is never needed on mainnet or testnet. It used
 * to be hardcoded in this file, which meant the published scaffold shipped a private
 * key to every browser that loaded the app. Configure it with
 * `NEXT_PUBLIC_MOCK_ZKV_SIGNER_PRIVATE_KEY` and use a throwaway local account.
 */
const readMockZkvSignerPrivateKey = (): `0x${string}` | undefined => {
  const configured = process.env.NEXT_PUBLIC_MOCK_ZKV_SIGNER_PRIVATE_KEY;
  if (!configured) {
    console.warn(
      "NEXT_PUBLIC_MOCK_ZKV_SIGNER_PRIVATE_KEY is not set: mock encrypted-input submission is disabled. " +
        "Set it to a throwaway local development account to use the MOCK environment."
    );
    return undefined;
  }
  return configured as `0x${string}`;
};

function createWalletClientFromPrivateKey(publicClient: PublicClient, privateKey: `0x${string}`): WalletClient {
  const account: PrivateKeyAccount = privateKeyToAccount(privateKey);
  return createWalletClient({
    account,
    chain: publicClient.chain,
    transport: http(publicClient.transport.url),
  });
}

export const useIsConnectedChainSupported = () => {
  const { chainId } = useAccount();
  return useMemo(
    () => scaffoldConfig.targetNetworks.some((network: chains.Chain) => network.id === chainId),
    [chainId],
  );
};

export function useInitializeCofhejs() {
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const isChainSupported = useIsConnectedChainSupported();

  const handleError = (error: string) => {
    console.error("cofhejs initialization error:", error);
    notification.error(`cofhejs initialization error: ${error}`);
  };

  useEffect(() => {
    const initializeCofhejs = async () => {
      // Early exit if any of the required dependencies are missing
      if (!publicClient || !walletClient || !isChainSupported) return;

      const chainId = publicClient?.chain.id;
      const environment = ChainEnvironments[chainId as keyof typeof ChainEnvironments] ?? "TESTNET";

      // The mock signer is only meaningful in the local MOCK environment. When no key is
      // configured we omit `mockConfig` entirely instead of falling back to a published key.
      const mockZkvSignerKey = readMockZkvSignerPrivateKey();
      const viemZkvSigner = mockZkvSignerKey
        ? createWalletClientFromPrivateKey(publicClient, mockZkvSignerKey)
        : undefined;

      try {
        const initializationResult = await cofhejs.initializeWithViem({
          viemClient: publicClient,
          viemWalletClient: walletClient,
          environment,
          // Whether to generate a permit for the connected account during the initialization process
          // Recommended to set to false, and then call `cofhejs.generatePermit()` when the user is ready to generate a permit
          // !! if **true** - will generate a permit immediately on page load !!
          generatePermit: false,
          // Hard coded signer for submitting encrypted inputs
          // This is only used in the mock environment to submit the mock encrypted inputs so that they can be used in FHE ops.
          // This has no effect in the mainnet or testnet environments.
          mockConfig: viemZkvSigner
            ? {
                decryptDelay: 1000,
                zkvSigner: viemZkvSigner,
              }
            : undefined,
        });

        if (initializationResult.success) {
          console.log("Cofhejs initialized successfully");
          notification.success("Cofhejs initialized successfully");
        } else {
          handleError(initializationResult.error.message ?? String(initializationResult.error));
        }
      } catch (err) {
        console.error("Failed to initialize cofhejs:", err);
        handleError(err instanceof Error ? err.message : "Unknown error initializing cofhejs");
      }
    };

    initializeCofhejs();
  }, [walletClient, publicClient, isChainSupported]);
}

type CofhejsStoreState = ReturnType<typeof cofhejs.store.getState>;

const useCofhejsStore = <T>(selector: (state: CofhejsStoreState) => T) => useStore(cofhejs.store, selector);

export const useCofhejsAccount = () => {
  return useCofhejsStore(state => state.account);
};

export const useCofhejsChainId = () => {
  return useCofhejsStore(state => state.chainId);
};

export const useCofhejsInitialized = () => {
  return useCofhejsStore(state => state.fheKeysInitialized && state.providerInitialized && state.signerInitialized);
};

export const useCofhejsStatus = () => {
  const chainId = useCofhejsChainId();
  const account = useCofhejsAccount();
  const initialized = useCofhejsInitialized();

  return useMemo(() => ({ chainId, account, initialized }), [chainId, account, initialized]);
};

// Permit Modal

interface CofhejsPermitModalStore {
  generatePermitModalOpen: boolean;
  generatePermitModalCallback?: () => void;
  setGeneratePermitModalOpen: (open: boolean, callback?: () => void) => void;
}

export const useCofhejsModalStore = create<CofhejsPermitModalStore>(set => ({
  generatePermitModalOpen: false,
  setGeneratePermitModalOpen: (open, callback) =>
    set({ generatePermitModalOpen: open, generatePermitModalCallback: callback }),
}));

// Permits

type PermitStoreState = ReturnType<typeof permitStore.store.getState>;

export const useCofhejsPermitStore = <T>(selector: (state: PermitStoreState) => T) => {
  return useStore(permitStore.store, selector);
};

export const useCofhejsActivePermitHash = () => {
  const { chainId, account, initialized } = useCofhejsStatus();
  return useCofhejsPermitStore(state => {
    if (!initialized || !chainId || !account) return undefined;
    return state.activePermitHash?.[chainId]?.[account];
  });
};

export const useCofhejsActivePermit = () => {
  const activePermitHash = useCofhejsActivePermitHash();
  return useMemo(() => {
    const permitResult = cofhejs.getPermit(activePermitHash ?? undefined);
    if (!permitResult) return null;
    if (permitResult.success) {
      return permitResult.data;
    } else {
      return null;
    }
  }, [activePermitHash]);
};

export const useCofhejsIsActivePermitValid = () => {
  const permit = useCofhejsActivePermit();
  return useMemo(() => {
    if (!permit) return false;
    return permit.isValid();
  }, [permit]);
};

export const useCofhejsAllPermitHashes = () => {
  const { chainId, account, initialized } = useCofhejsStatus();
  return useCofhejsPermitStore(
    useShallow(state => {
      if (!initialized || !chainId || !account) return [];
      return (
        Object.entries(state.permits?.[chainId]?.[account] ?? {})
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          .filter(([_, permit]) => permit !== undefined)
          .map(([hash]) => hash)
      );
    }),
  );
};

export const useCofhejsAllPermits = () => {
  const permitHashes = useCofhejsAllPermitHashes();
  return useMemo(() => {
    return permitHashes.map(hash => cofhejs.getPermit(hash));
  }, [permitHashes]);
};

export const useCofhejsCreatePermit = () => {
  const { chainId, account, initialized } = useCofhejsStatus();
  return useCallback(
    async (permit?: PermitOptions) => {
      if (!initialized || !chainId || !account) return;
      const permitResult = await cofhejs.createPermit(permit);
      if (permitResult.success) {
        notification.success("Permit created");
      } else {
        notification.error(permitResult.error.message ?? String(permitResult.error));
      }
      return permitResult;
    },
    [chainId, account, initialized],
  );
};

export const useCofhejsRemovePermit = () => {
  const { chainId, account, initialized } = useCofhejsStatus();
  return useCallback(
    async (permitHash: string) => {
      if (!initialized || !chainId || !account) return;
      permitStore.removePermit(chainId, account, permitHash);
      notification.success("Permit removed");
    },
    [chainId, account, initialized],
  );
};

export const useCofhejsSetActivePermit = () => {
  const { chainId, account, initialized } = useCofhejsStatus();
  return useCallback(
    async (permitHash: string) => {
      if (!initialized || !chainId || !account) return;
      permitStore.setActivePermitHash(chainId, account, permitHash);
      notification.success("Active permit updated");
    },
    [chainId, account, initialized],
  );
};

export const useCofhejsPermitIssuer = () => {
  const permit = useCofhejsActivePermit();
  return useMemo(() => {
    if (!permit) return null;
    return permit.issuer;
  }, [permit]);
};
