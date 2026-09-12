// Applied migration identities required by the Phase014 administration boundary.
export const ADMIN_MIGRATIONS = [
  {
    name: "20260910000000_init_user",
    sha256: "b65593d8d8a7a1821a2f65415616e5c083a0e38785bcac2a46ea362d126de3a3",
  },
  {
    name: "20260910172735_system_config",
    sha256: "25f5d0d35a216ee085fad468f5d69d740610369ff91fcdd0ebe4a188deef45cc",
  },
  {
    name: "20260911002217_travel_record_chat_message",
    sha256: "761979289b28f413d47c09290f43e9d01ffc22421918103a51d6c67b638bb48f",
  },
  {
    name: "20260911042258_audit_log",
    sha256: "9707b78108c51f9a10ebfa86fa816d7caf353bcd1f09a0cce2eefcac6b392373",
  },
  {
    name: "20260911104017_api_key_config",
    sha256: "9bc311e50f3dccc7dc7885a901285fd1f359beb0e3b808bdc1e4c16ab4ce79d1",
  },
  {
    name: "20260911151715_auth_session_login_attempt",
    sha256: "e4913a97a5ff09d9ee71efaebd58163b8b5f5db9f0fe7747bd07783aed66c08f",
  },
  {
    name: "20260912013806_admin_commands",
    sha256: "26eac34ab5c30b48adb680a3a770d4454503e3550b3009b4e59cc0dc43e2392d",
  },
  {
    name: "20260912061403_key_rotation_contract",
    sha256: "21eccfad37e0bf03d758a98f1bc5ef5b6b2bd6bf15d96490f9e923ba3b4eed4f",
  },
] as const;
