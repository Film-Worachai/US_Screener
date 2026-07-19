# SET_Screener

เปลี่ยนทริกเกอร์จาก `schedule` เป็น `repository_dispatch` (เพื่อให้สั่งรันผ่าน API ได้)
```yaml
on:
  repository_dispatch:
    types: [run-scanner-bot] # ชื่อ Event ที่เราจะตั้ง
  workflow_dispatch: # เก็บไว้ยามกด manual
```

**2. สร้าง Token ใน GitHub**
*   ไปที่ Settings ของ GitHub (มุมขวาบนสุด) > Developer settings > Personal access tokens > Tokens (classic)
*   กด **Generate new token (classic)**
*   ตั้งชื่อว่า `CRON_TOKEN`, เลือก Expiration เป็น `No expiration`
*   ติ๊กถูกที่ช่อง **`repo`** (เพื่อให้สิทธิ์การรันโค้ด)
*   กด Generate แล้ว **ก๊อปปี้ Token ยาวๆ เก็บไว้**

**3. ไปตั้งเวลาที่เว็บ cron-job.org (ฟรี 100%)**
*   สมัครสมาชิกเว็บ [cron-job.org](https://cron-job.org/)
*   กด Create Cronjob
*   ตั้งเวลาตามที่คุณต้องการเลย (มี Timezone กรุงเทพ ให้เลือก ไม่ต้องปวดหัวคำนวณ UTC แล้ว)
*   **ส่วนของ URL:** ใส่ `https://api.github.com/repos/ชื่อผู้ใช้/SET_Screener/dispatches` (เปลี่ยน "ชื่อผู้ใช้" เป็นชื่อ GitHub ของคุณ)
*   ติ๊กเลือก **Advanced** > เลือก Method เป็น **POST**
*   **ส่วน Headers:** เพิ่ม 2 ค่า
    *   `Accept` : `application/vnd.github.v3+json`
    *   `Authorization` : `Bearer <เอา_TOKEN_ที่ก๊อปไว้มาวางตรงนี้>`
*   **ส่วน Body:** ใส่เป็น JSON ดังนี้
    ```json
    {
      "event_type": "run-scanner-bot"
    }
    ```
*   กด Save

เพียงเท่านี้ เว็บ cron-job.org จะทำหน้าที่เป็นนาฬิกาปลุกที่ **ตรงเวลาเป๊ะระดับวินาที** ยิงคำสั่งมาที่ GitHub ให้เริ่มรันสคริปต์สแกนหุ้นของคุณครับ ไม่ต้องง้อคิวหรือรอดีเลย์จากระบบ Schedule ของ GitHub อีกต่อไป!
"# US_Screener" 
"# US_Screener" 
