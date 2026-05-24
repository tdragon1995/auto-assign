// Static list of Diag branch/PSC locations used by /api/cham-cong and /api/audit dropdowns.
// Sourced from Cartrack customer records. When a new PSC opens, add an entry here and redeploy.

export interface DiagLocation {
  customer_id: string;
  name: string;
  address: string;
}

export const DIAG_LOCATIONS: DiagLocation[] = [
  { customer_id: "3927b076-3af9-11ed-b939-506b8dbc8dfb", name: "D001", address: "414 - 420 Cao Thắng, Phường 12, Quận 10, Thành phố Hồ Chí Minh" },
  { customer_id: "7bc36d6c-3d6a-11ed-a1ac-506b8dbc8dfb", name: "D002", address: "309 Trần Phú, Phường 8, Quận 5, Thành phố Hồ Chí Minh" },
  { customer_id: "557ec732-3af9-11ed-b159-506b8dbc8dfb", name: "D003", address: "231 Hoàng Văn Thụ, Phường 8, Quận Phú Nhuận, Thành phố Hồ Chí Minh" },
  { customer_id: "1c89cd22-3d6b-11ed-b2d6-506b8dbc8dfb", name: "D004", address: "75 Lê Văn Việt, Phường Hiệp Phú, quận 9 Thành Phố Hồ Chí Minh" },
  { customer_id: "c4f51f56-1ba8-11f1-9378-fa163ee8d8ac", name: "D005", address: "99 Bình Thới, Phường 11, Quận 11, Thành phố Hồ Chí Minh" },
  { customer_id: "c07bc96a-3d81-11ed-989f-506b8dbc8dfb", name: "D006", address: "198 Nguyễn Thị Thập, Phường Bình Thuận, Quận 7, Thành phố Hồ Chí Minh" },
  { customer_id: "debfa9a0-3d81-11ed-9ba7-506b8dbc8dfb", name: "D007", address: "275 Tô Ngọc Vân, Phường Linh Đông, Quận Thủ Đức, Thành phố Hồ Chí Minh" },
  { customer_id: "7e6eb83c-3d83-11ed-b414-506b8dbc8dfb", name: "D009", address: "7 ( Phan Văn Hớn, Phường Tân Thới Nhất, Quận 12, Thành phố Hồ Chí Minh" },
  { customer_id: "9a15e7a4-3d83-11ed-be4e-506b8dbc8dfb", name: "D010", address: "101-103 Tên Lửa, Phường Bình Trị Đông B, Quận Bình Tân, Thành phố Hồ Chí Minh" },
  { customer_id: "bbdd2320-3d83-11ed-a15b-506b8dbc8dfb", name: "D011", address: "742 Lũy Bán Bích, Phường Tân Thành, Quận Tân Phú (Gần Cây xăng Tân Thạnh), Thành phố Hồ Chí Minh" },
  { customer_id: "c79d5fa2-3d85-11ed-a6db-506b8dbc8dfb", name: "D014", address: "495 Cách Mạng Tháng 8, Phường Phú Cường, Thành phố Thủ Dầu Một, Tỉnh Bình Dương" },
  { customer_id: "0c0b1998-3d88-11ed-8d9a-506b8dbc8dfb", name: "D015", address: "139 - 141 Võ Thị Sáu, Khu phố 7, Phường Thống Nhất, TP. Biên Hòa, Tỉnh Đồng Nai" },
  { customer_id: "f61cca44-3d89-11ed-b141-506b8dbc8dfb", name: "D016", address: "271 Nguyễn An Ninh, Khu phố Bình Minh 2, Phường Dĩ An, Thành phố Dĩ An, Tỉnh Bình Dương" },
  { customer_id: "6ec25112-3d8a-11ed-acb2-506b8dbc8dfb", name: "D017", address: "85 - 87 Nơ Trang Long, Phường 11, Quận Bình Thạnh, Thành phố Hồ Chí Minh" },
  { customer_id: "8d623ace-3d8a-11ed-87cc-506b8dbc8dfb", name: "D018", address: "53 Nguyễn Du, Phường Bến Nghé, Quận 1, Thành phố Hồ Chí Minh" },
  { customer_id: "a693faa0-3d8a-11ed-9fed-506b8dbc8dfb", name: "D019", address: "158 Trần Não, Phường Bình An, Quận 2, Thành phố Hồ Chí Minh" },
  { customer_id: "27eaf120-3d8c-11ed-9f85-506b8dbc8dfb", name: "D020", address: "793 Nguyễn Kiệm, phường 3 quận Gò Vấp, Thành phố Hồ Chí Minh" },
  { customer_id: "47cc1bf4-3d8c-11ed-95fc-506b8dbc8dfb", name: "D021", address: "102B - 104 Nam Kỳ Khởi Nghĩa, Phường 1, TP. Mỹ Tho, Tỉnh Tiền Giang" },
  { customer_id: "65d58b76-3d8c-11ed-b92b-506b8dbc8dfb", name: "D022", address: "829 Quang Trung, Phường 12, Quận Gò Vấp, Thành phố Hồ Chí Minh" },
  { customer_id: "c0bd4c76-3d8d-11ed-892d-506b8dbc8dfb", name: "D023", address: "260A Lê Lợi, Phường 4, TP. Vũng Tàu, Tỉnh Bà Rịa - Vũng Tàu" },
  { customer_id: "c995bfaa-3d9b-11ed-9a28-506b8dbc8dfb", name: "D026", address: "239 Khánh Hội, Phường 5, Quận 4, Thành phố Hồ Chí Minh" },
  { customer_id: "fee8236e-3d9b-11ed-9cc5-506b8dbc8dfb", name: "D027", address: "199B Phạm Hùng, Phường 4, Quận 8, Thành phố Hồ Chí Minh" },
  { customer_id: "90de3042-3d9c-11ed-a60a-506b8dbc8dfb", name: "D028", address: "39 Tỉnh lộ 8, Thị trấn Củ Chi, Thành phố Hồ Chí Minh" },
  { customer_id: "c81985d4-3d9c-11ed-8951-506b8dbc8dfb", name: "D029", address: "101 Đinh Tiên Hoàng, Phường Đa Kao, Quận 1, Thành phố Hồ Chí Minh" },
  { customer_id: "c450f244-3b21-11f1-9378-fa163ee8d8ac", name: "D030", address: "54Z1B Trần Nam Phú, Khu vực 2, Tân An, Cần Thơ" },
  { customer_id: "17dd37b4-3d9d-11ed-93b6-506b8dbc8dfb", name: "D032", address: "67A Nguyễn Văn Tiết, Phường Lái Thiêu, Thị xã Thuận An, Tỉnh Bình Dương" },
  { customer_id: "24b9b3d6-3d9d-11ed-b9a1-506b8dbc8dfb", name: "D033", address: "31/5 Quang Trung, Thị trấn Hóc Môn, Thành phố Hồ Chí Minh" },
  { customer_id: "77531e70-3d9d-11ed-bccd-506b8dbc8dfb", name: "D035", address: "1375 - 1377 Huỳnh Tấn Phát, KP4, Phường Phú Thuận, Quận 7, Thành phố Hồ Chí Minh" },
  { customer_id: "a22daf7a-3d9d-11ed-8890-506b8dbc8dfb", name: "D036", address: "129 Nguyễn Đình Chiểu, Phường 1, Thành phố Tân An, Tỉnh Long An" },
  { customer_id: "ec32d0d2-ceec-11ee-bad2-506b8d9879b5", name: "D037", address: "323 Nguyễn Duy Trinh, Phường Bình Trưng Tây, Quận 2, Thành phố Hồ Chí Minh" },
  { customer_id: "cc143b9c-ceec-11ee-9518-506b8d9879b5", name: "D038", address: "1166 Cách Mạng Tháng 8, Phường 4, Quận Tân Bình, Thành phố Hồ Chí Minh" },
  { customer_id: "b188329c-ceec-11ee-bae4-506b8d9879b5", name: "D039", address: "375 Nguyễn Văn Luông, Phường 12, Quận 6, Thành phố Hồ Chí Minh" },
  { customer_id: "af190f62-0ce6-11ef-ba8a-506b8d9879b5", name: "D040", address: "869 Phan Văn Trị, Phường 7, Quận Gò Vấp, Thành phố Hồ Chí Minh" },
  { customer_id: "21dcad6a-0ce7-11ef-af2f-506b8d9879b5", name: "D041", address: "75-77 Nguyễn Thị Tú, Phường Bình Hưng Hòa B, Quận Bình Tân, Thành phố Hồ Chí Minh" },
  { customer_id: "37c8f934-0ce8-11ef-900c-506b8d9879b5", name: "D042", address: "1B Đỗ Xuân Hợp, Phường Phước Bình, Quận 9, Thành phố Hồ Chí Minh" },
  { customer_id: "e5c037c2-0ce9-11ef-a2d8-506b8d9879b5", name: "D043", address: "379 Lê Văn Quới, Phường Bình Trị Đông A, Quận Bình Tân, Thành phố Hồ Chí Minh" },
  { customer_id: "ea93538a-5dd7-11ef-b329-506b8d9879b5", name: "D044", address: "145 - 147 Dương Bá Trạc, Phường 1, Quận 8, Thành phố Hồ Chí Minh" },
  { customer_id: "088b3eac-73db-11ef-a38c-506b8d9879b5", name: "D045", address: "417 Hai Bà Trưng, Phường Võ Thị Sáu, Quận 3, Thành phố Hồ Chí Minh" },
  { customer_id: "16db29e0-73db-11ef-baa3-506b8d9879b5", name: "D046", address: "227A Xô Viết Nghệ Tĩnh, Phường 17, Quận Bình Thạnh, Tp. HCM" },
  { customer_id: "21415bde-73db-11ef-8478-506b8d9879b5", name: "D047", address: "963 Ba Tháng Hai, Phường 6, Quận 11, Thành phố Hồ Chí Minh" },
  { customer_id: "2d13fd86-73db-11ef-a0d1-506b8d9879b5", name: "D048", address: "635 Lạc Long Quân, Phường 10, Quận Tân Bình, Thành phố Hồ Chí Minh" },
  { customer_id: "0df4f904-0f8b-11f0-b683-506b8d982279", name: "D049", address: "1075 Nguyễn Trãi, Phường 14, Quận 5, Thành phố Hồ Chí Minh" },
  { customer_id: "3d68332c-6698-11f0-a623-506b8d982279", name: "D050", address: "211 Lê Văn Sỹ, Phường 12, Quận 3, Thành Phố Hồ Chí Minh" },
  { customer_id: "4daa0bca-2d7b-11f1-9378-fa163ee8d8ac", name: "D051", address: "51 Võ Nguyên Giáp, Thảo Điền, An Khánh, Hồ Chí Minh" },
];
