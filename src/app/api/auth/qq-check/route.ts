import { ok } from "@/lib/api";

/**
 * POST /api/auth/qq-check
 *
 * 直接返回硬编码的 QQ 音乐登录态，不再走二维码轮询。
 */
export async function POST() {
  return ok({
    status: "success" as const,
    cookie:
      "uin=2767868647; " +
      "qqmusic_key=Q_H_L_63k3Nock6YFoyY68Xf6zwvQP7iIM_nSYw2iEbdBiX9Lt0HCQ19fAHV1-CqvIVmdA-H2q4zPMTOteiLzo7yy_lsHREhgBZbw; " +
      "qm_keyst=Q_H_L_63k3Nock6YFoyY68Xf6zwvQP7iIM_nSYw2iEbdBiX9Lt0HCQ19fAHV1-CqvIVmdA-H2q4zPMTOteiLzo7yy_lsHREhgBZbw; " +
      "psrf_access_token_expiresAt=1799965880; " +
      "psrf_musickey_createtime=1794781880; " +
      "psrf_qqaccess_token=07D29D587B3C258C2CCB3CFF363DA0A9; " +
      "psrf_qqopenid=414D5125FBEF14E40CAD5B7DC8DDC264; " +
      "psrf_qqrefresh_token=1346ADDE007ABBFD8375EFCF36531CA5; " +
      "psrf_qqunionid=FE4FB795E4A5B7C952011C4862F94C1F; " +
      "euin=owSs7icsNeCP7z**; " +
      "login_type=1; " +
      "tmeLoginType=2; " +
      "music_ignore_pskey=202306271436Hn@vBj; " +
      "qlogin_uid=def6c175e51588152578df49eac07b70; " +
      "ptui_loginuin=2767868647; " +
      "pgv_pvid=6761286960; " +
      "pgv_info=ssid=s4085103216; " +
      "ts_last=y.qq.com/; " +
      "ts_refer=ADTAGmyqq; " +
      "ts_uid=8925255875; " +
      "RK=tL7b/AqQsT; " +
      "ptcz=ec8bd7f9ba08558f2676847bc685dcf1c9be353888dc226ee7044da2e33c31e2; " +
      "fqm_pvqid=b4afc546-8fcd-489b-86fe-92473ebbe3ea; " +
      "fqm_sessionid=f0f10c00-8a85-4d1d-a6a3-60445015d17b; " +
      "_tme_cid=cid_v1_708484d1872a56fa744c16ab70f28115eb0d; " +
      "_tme_did=secid_v1_d56a1860f27a63baaa847e6894b36bbb5459",
    uin: "2767868647",
    message: "使用硬编码 cookie",
    user: {
      userId: "2767868647",
      nickname: "QQ 2767868647",
      avatarUrl: "https://q.qlogo.cn/g?b=qq&nk=2767868647&s=140",
    },
  });
}
