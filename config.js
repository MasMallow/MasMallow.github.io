// ===== การตั้งค่า Firebase (สำหรับโหมดคลาวด์ — แชร์ข้อมูลให้ทั้งกิลด์) =====
// เอาค่าจาก console.firebase.google.com → โปรเจกต์ของคุณ → Project Settings → Your apps → Web app → SDK setup
// ปล่อย apiKey ว่าง = ใช้โหมดเดิม (local server / localStorage)
window.APP_CONFIG = {
  firebase: {
    apiKey: 'AIzaSyAj_YK0J-R7WM44qiWeDa-Ql6zLff3iW-8',
    authDomain: 'albion-de483.firebaseapp.com',
    databaseURL: 'https://albion-de483-default-rtdb.asia-southeast1.firebasedatabase.app',
    projectId: 'albion-de483',
    storageBucket: 'albion-de483.firebasestorage.app',
    messagingSenderId: '137597864683',
    appId: '1:137597864683:web:f34dd1a1cc700e63340cae',
  },
};
